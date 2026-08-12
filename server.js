'use strict';

const express = require('express');
const path = require('path');
const { YemotRouter } = require('yemot-router2');
const store = require('./store');
const { handoffToPayment } = require('./payment');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'החנות הטלפונית';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

/* =========================================================
 *  1) קו טלפוני (IVR) — ימות המשיח, yemot-router2
 * ========================================================= */

const router = YemotRouter({ printLog: true, timeout: 0 });

// שלוחה ראשית — נקודת הכניסה של הקו
router.get('/', async (call) => {
  try {
    // ברכה
    await call.id_list_message(
      [{ type: 'text', data: `ברוכים הבאים ל ${BUSINESS_NAME}` }],
      { prependToNextAction: true }
    );

    const catalog = store.getCatalog().filter((p) => p.active);
    if (catalog.length === 0) {
      call.id_list_message([{ type: 'text', data: 'אין כרגע מוצרים זמינים. נסו מאוחר יותר.' }]);
      return call.hangup();
    }

    // תפריט מוצרים — מקריא שם + מחיר, והספרה להקשה
    const menu = [{ type: 'text', data: 'לביצוע הזמנה, הקישו את מספר המוצר.' }];
    catalog.forEach((p, i) => {
      menu.push({ type: 'text', data: `למוצר ${p.name} במחיר ${p.price} שקלים, הקישו ${i + 1}.` });
    });

    const pick = await call.read(menu, 'tap', {
      max_digits: 2,
      min_digits: 1,
      sec_wait: 10,
      digits_allowed: catalog.map((_, i) => i + 1),
    });

    const product = catalog[Number(pick) - 1];
    if (!product) {
      call.id_list_message([{ type: 'text', data: 'בחירה לא תקינה. נסו שוב.' }], { prependToNextAction: true });
      return call.restart_ext();
    }

    // כמות
    const qtyRaw = await call.read(
      [{ type: 'text', data: `בחרתם ${product.name}. כמה יחידות? הקישו מספר ואז סולמית.` }],
      'tap',
      { max_digits: 2, min_digits: 1, sec_wait: 10 }
    );
    const qty = Math.max(1, Number(qtyRaw) || 1);
    const total = qty * product.price;

    // שם הלקוח — הקלטה (נשמרת בימות; אנחנו שומרים רק את נתיב הקובץ)
    const nameRec = await call.read(
      [{ type: 'text', data: 'אמרו את שמכם המלא לאחר הצליל, וסיימו בסולמית.' }],
      'record',
      { no_confirm_menu: true }
    );

    // כתובת למשלוח — הקלטה
    const addrRec = await call.read(
      [{ type: 'text', data: 'אמרו את הכתובת המלאה למשלוח: עיר, רחוב, מספר בית ודירה. סיימו בסולמית.' }],
      'record',
      { no_confirm_menu: true }
    );

    // יצירת ההזמנה במערכת כ"ממתין לתשלום". סימון "שולם" נעשה אחרי הסליקה
    // (ידנית בלוח הבקרה, או אוטומטית דרך /yemot/paid — ראה README).
    const order = store.createOrder({
      phone: call.phone,
      productCode: product.code,
      productName: product.name,
      qty,
      unitPrice: product.price,
      total,
      nameRecording: typeof nameRec === 'string' ? nameRec : '',
      addressRecording: typeof addrRec === 'string' ? addrRec : '',
      paymentStatus: 'pending',
      supplierUrl: product.supplierUrl || '',
    });

    // סיכום + הודעה, ואז העברה לשלוחת הסליקה המאובטחת של ימות.
    // חשוב: prependToNextAction=true כדי שההודעה תושמע לפני המעבר לשלוחה.
    await call.id_list_message(
      [
        { type: 'text', data: `סיכום ההזמנה: ${qty} יחידות ${product.name}. סך הכל לתשלום ${total} שקלים.` },
        { type: 'text', data: `מספר ההזמנה שלכם הוא ${order.id}. כעת נעביר אתכם להשלמת התשלום.` },
      ],
      { prependToNextAction: true }
    );

    // העברה לשלוחת התשלום (הזנת הכרטיס קורית שם, מאובטח, אצל ימות)
    return handoffToPayment(call, total);
  } catch (err) {
    console.error('IVR error:', err);
    try {
      call.id_list_message([{ type: 'text', data: 'אירעה תקלה. נסו שוב מאוחר יותר.' }]);
      call.hangup();
    } catch (_) {}
  }
});

// עדכון "שולם" חזרה מהסליקה (לא חובה, אבל אוטומטי ונקי).
// בשלוחת התשלום בימות, אחרי סליקה מוצלחת, הגדר קריאת API החוצה אל:
//   https://<your-app>/paid?order=<מספר ההזמנה>&ref=<אסמכתא>
// (מגדירים ב"הוסף/י קריאת API" של השלוחה. אין כאן מספר כרטיס — רק אסמכתא.)
app.get('/paid', (req, res) => {
  const id = req.query.order;
  const ref = req.query.ref || '';
  const updated = store.updateOrder(id, { paymentStatus: 'paid', paymentRef: String(ref) });
  if (!updated) return res.status(404).send('order not found');
  res.send('OK');
});

// מרכיבים את ראוטר ימות. ימות שולח בקשות ל- /yemot כברירת מחדל כאן.
app.use('/yemot', router);

/* =========================================================
 *  2) API לניהול (משמש את לוח הבקרה admin.html)
 * ========================================================= */

// שער סיסמה פשוט. בפרודקשן — החלף באימות אמיתי (JWT / OAuth).
function requireAuth(req, res, next) {
  const pass = req.get('x-admin-password') || req.query.pw;
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/api/catalog', requireAuth, (req, res) => res.json(store.getCatalog()));

app.post('/api/catalog', requireAuth, (req, res) => {
  if (!req.body.code || !req.body.name) return res.status(400).json({ error: 'code and name required' });
  res.json(store.upsertProduct(req.body));
});

app.delete('/api/catalog/:code', requireAuth, (req, res) => {
  store.deleteProduct(req.params.code);
  res.json({ ok: true });
});

app.get('/api/orders', requireAuth, (req, res) => res.json(store.getOrders()));

app.post('/api/orders/:id', requireAuth, (req, res) => {
  const updated = store.updateOrder(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

/* =========================================================
 *  3) הגשת לוח הבקרה (סטטי)
 * ========================================================= */

app.use('/admin', express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/admin'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n▶ ${BUSINESS_NAME}`);
  console.log(`  IVR (ימות)   →  POST/GET  http://localhost:${PORT}/yemot`);
  console.log(`  לוח בקרה     →  http://localhost:${PORT}/admin`);
  console.log(`  סיסמת ניהול  →  ${ADMIN_PASSWORD === 'change-me' ? '⚠ change-me (החלף!)' : '(מוגדרת)'}\n`);
});

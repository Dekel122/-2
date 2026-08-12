'use strict';
/**
 * אחסון פשוט מבוסס קובץ JSON.
 * מספיק ל-MVP ולפריסה ב-Render (בלי תלויות native).
 * לשלב הבא: להחליף ב-SQLite / Postgres. הממשק כאן נשאר זהה.
 *
 * שים לב: ב-Render (Free) הדיסק אֶפֶמֶרִי — הקובץ נמחק בכל דיפלוי/הפעלה מחדש.
 * לפרודקשן אמיתי חבר Render Disk בתשלום, או DB חיצוני.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ catalog: [], orders: [], seq: 1000 }, null, 2));
  }
}

function load() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { catalog: [], orders: [], seq: 1000 };
  }
}

function save(db) {
  ensure();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* ---------- קטלוג ---------- */

function getCatalog() {
  return load().catalog;
}

function getProduct(code) {
  return load().catalog.find((p) => String(p.code) === String(code)) || null;
}

function upsertProduct(prod) {
  const db = load();
  const idx = db.catalog.findIndex((p) => String(p.code) === String(prod.code));
  const clean = {
    code: String(prod.code),
    name: String(prod.name || '').trim(),
    price: Number(prod.price) || 0,        // מחיר מכירה ללקוח (שקל)
    cost: Number(prod.cost) || 0,          // עלות בעליבאבא (שקל, לרווחיות)
    supplierUrl: String(prod.supplierUrl || '').trim(), // קישור המוצר בעליבאבא לפקידת מילוי
    active: prod.active !== false,
  };
  if (idx >= 0) db.catalog[idx] = { ...db.catalog[idx], ...clean };
  else db.catalog.push(clean);
  save(db);
  return clean;
}

function deleteProduct(code) {
  const db = load();
  db.catalog = db.catalog.filter((p) => String(p.code) !== String(code));
  save(db);
}

/* ---------- הזמנות ---------- */

function createOrder(order) {
  const db = load();
  const id = ++db.seq;
  const record = {
    id,
    createdAt: new Date().toISOString(),
    phone: order.phone || '',
    productCode: order.productCode || '',
    productName: order.productName || '',
    qty: Number(order.qty) || 1,
    unitPrice: Number(order.unitPrice) || 0,
    total: Number(order.total) || 0,
    // הקלטות שמורות בימות (לא אצלנו): נשמור רק מזהי קבצים אם קיימים
    nameRecording: order.nameRecording || '',
    addressRecording: order.addressRecording || '',
    // תשלום — נשמר רק אישור/טוקן מהסליקה, לעולם לא מספר כרטיס
    paymentStatus: order.paymentStatus || 'pending', // pending | paid | failed
    paymentRef: order.paymentRef || '',
    supplierUrl: order.supplierUrl || '',
    status: 'new', // new | ordered | shipped | done | canceled
    supplierOrderId: '',
    notes: '',
  };
  db.orders.unshift(record);
  save(db);
  return record;
}

function getOrders() {
  return load().orders;
}

function updateOrder(id, patch) {
  const db = load();
  const idx = db.orders.findIndex((o) => String(o.id) === String(id));
  if (idx < 0) return null;
  const allowed = ['status', 'supplierOrderId', 'notes', 'paymentStatus', 'paymentRef'];
  for (const k of allowed) {
    if (k in patch) db.orders[idx][k] = patch[k];
  }
  save(db);
  return db.orders[idx];
}

module.exports = {
  getCatalog, getProduct, upsertProduct, deleteProduct,
  createOrder, getOrders, updateOrder,
};

// Standalone test for modifyItem (backend/server.js).
// Extracts modifyItem's source directly from server.js at run time — it does
// NOT require/start server.js (no Express app, no Anthropic client, no
// app.listen) and does NOT modify server.js in any way.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SERVER_PATH = path.join(__dirname, "server.js");
const MENU_PATH = path.join(__dirname, "..", "data", "menu.json");

const MENU_ITEMS = JSON.parse(fs.readFileSync(MENU_PATH, "utf-8"));

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  if (start === -1) {
    throw new Error(`Could not find function ${functionName}() in ${SERVER_PATH}`);
  }

  let i = source.indexOf("{", start);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }

  return source.slice(start, i + 1);
}

const serverSource = fs.readFileSync(SERVER_PATH, "utf-8");
const modifyItemSource = extractFunctionSource(serverSource, "modifyItem");

const modifyItem = new Function(
  "MENU_ITEMS",
  `${modifyItemSource}\nreturn modifyItem;`
)(MENU_ITEMS);

function freshOrderState() {
  return {
    items: [],
    quantities: {},
    options: {},
    orderType: null,
    customer: { name: null, phone: null, email: null },
    discount: null,
    total: 0,
    confirmed: false,
    status: "building",
  };
}

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`PASS: ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${label}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

check("itemId not in cart -> item_not_in_cart, no crash, state untouched", () => {
  const orderState = freshOrderState();

  const result = modifyItem({ itemId: "caffe-latte", quantity: 2 }, orderState);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, "item_not_in_cart");
  assert.strictEqual(typeof result.message, "string");
  assert.deepStrictEqual(orderState.items, []);
  assert.deepStrictEqual(orderState.quantities, {});
});

check("invalid size for a valid in-cart item -> invalid_size, no crash, state untouched", () => {
  const orderState = freshOrderState();
  orderState.items = ["caffe-latte"];
  orderState.quantities["caffe-latte"] = 1;
  orderState.options["caffe-latte"] = { size: "Medium", extras: [] };

  const result = modifyItem({ itemId: "caffe-latte", size: "Extra Large" }, orderState);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, "invalid_size");
  assert.deepStrictEqual(result.validSizes, ["Small", "Medium", "Large"]);
  assert.strictEqual(orderState.options["caffe-latte"].size, "Medium");
  assert.strictEqual(orderState.quantities["caffe-latte"], 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

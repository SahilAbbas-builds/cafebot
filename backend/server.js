const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

// Session/cart storage: an in-memory Map, keyed by a session-id cookie. This
// is a development/demo convenience only, not a real session store — it has
// no persistence and is cleared whenever the process restarts.
//
// This does NOT reliably work in production on Vercel (or any serverless
// platform): serverless functions are not one long-running process. Requests
// for the same session cookie can be routed to different function instances
// — each with its own empty orderSessions Map and no shared memory between
// them — or to a fresh cold-started instance that has never seen that
// session at all. In practice this means a customer's in-progress cart can
// silently reset mid-conversation on Vercel, since there is no guarantee two
// consecutive chat requests hit the same instance. Known limitation — do not
// treat this as production-ready session state. A real fix needs an external
// session store shared across instances (e.g. Vercel KV or Redis) in place
// of this Map; that is not implemented here.
const SESSION_COOKIE_NAME = "cafebot_session";
const orderSessions = new Map(); // sessionId -> order state

function createOrderState() {
  return {
    items: [],
    quantities: {},
    options: {},
    orderType: null,
    customer: { name: null, phone: null, email: null },
    pickupTime: null,
    deliveryAddress: null,
    aptUnit: null,
    deliveryInstructions: null,
    discount: null,
    total: 0,
    confirmed: false,
    status: "building",
    savedOrderId: null,
  };
}

function getSessionId(req, res) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));

  if (match) {
    return match.split("=")[1];
  }

  const sessionId = crypto.randomUUID();
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24, // 24 hours
  });
  return sessionId;
}

function getOrderState(req, res) {
  const sessionId = getSessionId(req, res);
  if (!orderSessions.has(sessionId)) {
    orderSessions.set(sessionId, createOrderState());
  }
  return orderSessions.get(sessionId);
}

const client = new Anthropic({ maxRetries: 3 });

const BRAND_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "brand.config.json"), "utf-8")
);
const SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, "..", "prompts", "system-prompt.md"),
  "utf-8"
);
const SYSTEM_PROMPT = SYSTEM_PROMPT_TEMPLATE.replaceAll(
  "{{ASSISTANT_NAME}}",
  BRAND_CONFIG.assistantName
).replaceAll("{{CAFE_NAME}}", BRAND_CONFIG.cafeName);
const MENU_ITEMS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "menu.json"), "utf-8")
);
// Computed once at startup so its bytes are identical on every request —
// required for the prompt-caching breakpoint below to actually hit.
const AVAILABLE_MENU_ITEMS = MENU_ITEMS.filter((item) => item.available);
const MENU_CONTEXT_TEXT =
  "Current menu data (JSON) — the same items and fields the getMenu tool " +
  "returns. Treat this as the real, current menu; you can still call getMenu " +
  "mid-conversation if you want to double-check availability.\n\n" +
  JSON.stringify(AVAILABLE_MENU_ITEMS, null, 2);
const PROMOTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "promotions.json"), "utf-8")
);

// Simple flat config — no per-category tax rules, no distance-based delivery pricing.
const TAX_RATE = 0.08;
const DELIVERY_FEE = 3.5;

// Any tool that can change the order after it's been confirmed invalidates that
// confirmation — the customer must review and confirm the order again.
const ORDER_MUTATING_TOOLS = new Set([
  "addItemToCart",
  "modifyItem",
  "removeItem",
  "applyPromotion",
  "setPickupDetails",
  "setDeliveryDetails",
]);

// Orders storage: reads/writes orders.json directly on disk. This is a
// development/demo convenience only, not a database — there's no locking,
// concurrency control, or durability guarantee.
//
// On Vercel (or other serverless platforms) the deployed bundle's filesystem
// is read-only, so writing to data/orders.json there fails outright — this
// broke order confirmation and status updates in production entirely (every
// write threw, caught as "technical problem saving the order"). As a
// stopgap, order storage is redirected to /tmp — the one writable directory
// a Vercel function gets — when the VERCEL env var is set, so checkout
// works again. /tmp is still not real persistence: it's ephemeral per
// function instance, can be wiped on a cold start, and isn't shared across
// instances, so an order can still fail to show up on the staff dashboard
// depending on which instance handles a given request. Replace with a real
// database (e.g. Vercel Postgres/KV) before relying on this in production.
//
// orders.json keeps a leading comment noting it's dev-only, non-database storage —
// strip it to parse, re-add it on write so the file stays self-documenting.
const ORDERS_PATH = process.env.VERCEL
  ? path.join("/tmp", "orders.json")
  : path.join(__dirname, "..", "data", "orders.json");
const ORDERS_FILE_HEADER =
  "// TEMPORARY dev-only order storage. Not a database — revisit before production.";

function readOrders() {
  let raw;
  try {
    raw = fs.readFileSync(ORDERS_PATH, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return JSON.parse(raw.replace(/^\s*\/\/.*(\r?\n)/, ""));
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_PATH, `${ORDERS_FILE_HEADER}\n${JSON.stringify(orders, null, 2)}\n`, "utf-8");
}

const tools = [
  {
    name: "getMenu",
    description:
      "Get the café's current menu. Returns only items that are currently available " +
      "(in stock / on offer), with name, description, price, sizes, options, and allergens. " +
      "This is the only source of truth for menu items and prices — never invent items or prices.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "addItemToCart",
    description:
      "Add a menu item to the customer's order. itemId must be a valid, available item id " +
      "from getMenu — call getMenu first if you don't already know it. If the item has sizes " +
      "and no valid size is given, or an option isn't one of the item's listed options, this " +
      "call fails and tells you what's missing — ask the customer instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "The item's id, exactly as returned by getMenu.",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          description: "How many of this item to add. Defaults to 1.",
        },
        size: {
          type: "string",
          description: "Chosen size. Required if the item has a non-empty sizes list.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Chosen customizations, each must match one of the item's listed options.",
        },
      },
      required: ["itemId"],
    },
  },
  {
    name: "modifyItem",
    description:
      "Adjust the quantity, size, and/or options of an item already in the customer's order. " +
      "itemId must already be in the cart — use addItemToCart to add a new item instead. Only " +
      "include the fields being changed; omitted fields are left as-is. A given size or options " +
      "must be valid for that menu item, or this call fails and tells you what's valid — ask the " +
      "customer instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "The id of the item already in the cart to modify.",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          description: "New quantity for this item, if changing it.",
        },
        size: {
          type: "string",
          description: "New size for this item, if changing it. Must be one of the item's valid sizes.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "New full set of options for this item, if changing them. Replaces the existing " +
            "options entirely — pass an empty array to clear all options.",
        },
      },
      required: ["itemId"],
    },
  },
  {
    name: "removeItem",
    description:
      "Remove an item from the customer's order, or reduce its quantity. itemId must already " +
      "be in the cart. Omit quantity (or pass a quantity at or above the current amount) to " +
      "remove the item entirely; pass a smaller quantity to just reduce how many are ordered.",
    input_schema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "The id of the item already in the cart to remove or reduce.",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          description:
            "How many to remove. Omit to remove the item entirely. If this is greater than or " +
            "equal to the current quantity, the item is removed entirely.",
        },
      },
      required: ["itemId"],
    },
  },
  {
    name: "viewCart",
    description:
      "Show a concise summary of the customer's current order — items, quantities, sizes, " +
      "and customizations. Does not include prices or a total.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "applyPromotion",
    description:
      "Check or apply promotions from the real promotions list against the current order. " +
      "Call with no promotionId to see which currently-active promotions the order qualifies " +
      "for right now (use this to recommend one — never invent a promotion or discount code). " +
      "Call with a promotionId to actually apply that promotion; it only succeeds if that " +
      "promotion is active and the order currently satisfies its eligibility rules. Never accept " +
      "a discount code or promotion name from the customer that isn't confirmed via this tool.",
    input_schema: {
      type: "object",
      properties: {
        promotionId: {
          type: "string",
          description:
            "The id of a specific promotion to apply, exactly as returned by this tool. Omit to " +
            "just check which active promotions currently qualify.",
        },
      },
      required: [],
    },
  },
  {
    name: "setPickupDetails",
    description:
      "Set up the customer's pickup order: their name (required) and an optional pickup time. " +
      "Call with no arguments first to see what's already known and what's still missing — only " +
      "ask the customer for fields this reports as missing, never re-ask for something already set. " +
      "Call again with name and/or pickupTime once the customer gives them.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Customer's name for the pickup order.",
        },
        pickupTime: {
          type: "string",
          description:
            "Requested pickup time as the customer said it, e.g. '3:30 PM' or 'in 20 minutes'. " +
            "Optional — if not given, the order is prepared as soon as possible.",
        },
      },
      required: [],
    },
  },
  {
    name: "setDeliveryDetails",
    description:
      "Set up the customer's delivery order: name, phone number, and full delivery address are " +
      "required; apartment/unit and delivery instructions are optional. Call with no arguments " +
      "first to see what's already known and what's still missing — only ask the customer for " +
      "fields this reports as missing, never guess or re-ask for something already set. Call " +
      "again with whichever fields the customer gives you.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Customer's name for the delivery order.",
        },
        phone: {
          type: "string",
          description: "Customer's phone number, as they gave it.",
        },
        address: {
          type: "string",
          description: "Full delivery street address (street, city, etc.).",
        },
        aptUnit: {
          type: "string",
          description: "Apartment or unit number, if applicable.",
        },
        deliveryInstructions: {
          type: "string",
          description: "Delivery instructions, e.g. gate code, 'leave at door'. Optional.",
        },
      },
      required: [],
    },
  },
  {
    name: "calculateOrderTotal",
    description:
      "Calculate the customer's exact order total: subtotal from real menu prices and " +
      "quantities, any currently valid active promotion, tax, and delivery fee (delivery " +
      "orders only). This is the only source of truth for the total — never calculate, " +
      "estimate, or state a subtotal, tax, or total yourself. Call this any time you need " +
      "to show the customer a price total, especially before checkout.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "getOrderSummary",
    description:
      "Generate the complete, structured order summary: items with quantities and " +
      "customizations, fulfillment details (pickup or delivery), any valid applied " +
      "promotion, and the exact total. Always call this right before asking the customer " +
      "for final checkout confirmation, and read back only what it returns — never assemble " +
      "or restate the summary from memory or from other tool calls. Check readyForCheckout " +
      "and the missing fields it reports before asking for confirmation.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "confirmOrder",
    description:
      "Confirm the order, save it, and get back its order ID. Only call this after showing " +
      "the customer the full getOrderSummary output and receiving an explicit, unambiguous " +
      "'yes' from them in response to that exact summary — e.g. 'yes that's correct', " +
      "'confirm it', 'go ahead, place it'. Never call this on an ambiguous or non-committal " +
      "reply ('ok', 'sure', 'I guess', 'sounds good' said in passing, silence) — ask a direct " +
      "yes/no question instead and wait for a clear answer. This call fails on its own if the " +
      "order isn't actually complete, as an extra safeguard. Share the returned order ID with " +
      "the customer once it succeeds. If the customer already confirmed this order once and " +
      "then changed it, calling this again updates that same saved order (same order ID) — " +
      "check the returned 'updated' flag and tell the customer their order was updated, not " +
      "that a new one was placed.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

function addItemToCart(input, orderState) {
  const { itemId, quantity, size, options } = input || {};

  const item = MENU_ITEMS.find((m) => m.id === itemId && m.available);
  if (!item) {
    return {
      success: false,
      error: "invalid_item",
      message: `No available menu item with id "${itemId}". Call getMenu to see valid items.`,
    };
  }

  if (item.sizes.length > 0 && (!size || !item.sizes.includes(size))) {
    return {
      success: false,
      error: "missing_or_invalid_size",
      message: `"${item.name}" requires a size. Ask the customer to choose one of: ${item.sizes.join(", ")}.`,
      validSizes: item.sizes,
    };
  }

  const chosenOptions = Array.isArray(options) ? options : [];
  const invalidOptions = chosenOptions.filter((o) => !item.options.includes(o));
  if (invalidOptions.length > 0) {
    return {
      success: false,
      error: "invalid_option",
      message:
        `${invalidOptions.join(", ")} ${invalidOptions.length > 1 ? "are" : "is"} not valid ` +
        `for "${item.name}". Valid options: ${item.options.length ? item.options.join(", ") : "none"}.`,
      validOptions: item.options,
    };
  }

  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;

  if (!orderState.items.includes(itemId)) {
    orderState.items.push(itemId);
    orderState.quantities[itemId] = qty;
  } else {
    orderState.quantities[itemId] += qty;
  }
  orderState.options[itemId] = { size: size || null, extras: chosenOptions };

  orderState.total = orderState.items.reduce((sum, id) => {
    const menuItem = MENU_ITEMS.find((m) => m.id === id);
    return sum + menuItem.price * (orderState.quantities[id] || 0);
  }, 0);
  orderState.total = Math.round(orderState.total * 100) / 100;

  return {
    success: true,
    cart: {
      items: orderState.items.map((id) => ({
        itemId: id,
        name: MENU_ITEMS.find((m) => m.id === id).name,
        quantity: orderState.quantities[id],
        size: orderState.options[id].size,
        options: orderState.options[id].extras,
      })),
      total: orderState.total,
    },
  };
}

function modifyItem(input, orderState) {
  const { itemId, quantity, size, options } = input || {};

  if (!orderState.items.includes(itemId)) {
    return {
      success: false,
      error: "item_not_in_cart",
      message: `"${itemId}" is not in the customer's order yet. Use addItemToCart to add it first.`,
    };
  }

  if (quantity === undefined && size === undefined && options === undefined) {
    return {
      success: false,
      error: "nothing_to_modify",
      message: "No quantity, size, or options were given to change.",
    };
  }

  const item = MENU_ITEMS.find((m) => m.id === itemId && m.available);
  if (!item) {
    return {
      success: false,
      error: "invalid_item",
      message: `"${itemId}" is no longer a valid, available menu item. Call getMenu to see current items.`,
    };
  }

  if (quantity !== undefined && !(Number.isInteger(quantity) && quantity > 0)) {
    return {
      success: false,
      error: "invalid_quantity",
      message: "Quantity must be a whole number of 1 or more.",
    };
  }

  if (size !== undefined) {
    if (item.sizes.length === 0) {
      return {
        success: false,
        error: "no_sizes_for_item",
        message: `"${item.name}" doesn't have size options.`,
      };
    }
    if (!item.sizes.includes(size)) {
      return {
        success: false,
        error: "invalid_size",
        message: `"${size}" isn't a valid size for "${item.name}". Ask the customer to choose one of: ${item.sizes.join(", ")}.`,
        validSizes: item.sizes,
      };
    }
  }

  let newOptions;
  if (options !== undefined) {
    if (!Array.isArray(options)) {
      return {
        success: false,
        error: "invalid_options",
        message: "Options must be a list of strings.",
      };
    }
    const invalidOptions = options.filter((o) => !item.options.includes(o));
    if (invalidOptions.length > 0) {
      return {
        success: false,
        error: "invalid_option",
        message:
          `${invalidOptions.join(", ")} ${invalidOptions.length > 1 ? "are" : "is"} not valid ` +
          `for "${item.name}". Valid options: ${item.options.length ? item.options.join(", ") : "none"}.`,
        validOptions: item.options,
      };
    }
    newOptions = options;
  }

  if (quantity !== undefined) {
    orderState.quantities[itemId] = quantity;
  }
  const current = orderState.options[itemId] || { size: null, extras: [] };
  orderState.options[itemId] = {
    size: size !== undefined ? size : current.size,
    extras: newOptions !== undefined ? newOptions : current.extras,
  };

  orderState.total = orderState.items.reduce((sum, id) => {
    const menuItem = MENU_ITEMS.find((m) => m.id === id);
    return sum + menuItem.price * (orderState.quantities[id] || 0);
  }, 0);
  orderState.total = Math.round(orderState.total * 100) / 100;

  return {
    success: true,
    cart: {
      items: orderState.items.map((id) => ({
        itemId: id,
        name: MENU_ITEMS.find((m) => m.id === id).name,
        quantity: orderState.quantities[id],
        size: orderState.options[id].size,
        options: orderState.options[id].extras,
      })),
      total: orderState.total,
    },
  };
}

function removeItem(input, orderState) {
  const { itemId, quantity } = input || {};

  if (!orderState.items.includes(itemId)) {
    return {
      success: false,
      error: "item_not_in_cart",
      message: `"${itemId}" is not in the customer's order.`,
    };
  }

  if (quantity !== undefined && !(Number.isInteger(quantity) && quantity > 0)) {
    return {
      success: false,
      error: "invalid_quantity",
      message: "Quantity to remove must be a whole number of 1 or more.",
    };
  }

  const currentQty = orderState.quantities[itemId] || 0;
  const removedEntirely = quantity === undefined || quantity >= currentQty;
  const quantityRemoved = removedEntirely ? currentQty : quantity;

  if (removedEntirely) {
    orderState.items = orderState.items.filter((id) => id !== itemId);
    delete orderState.quantities[itemId];
    delete orderState.options[itemId];
  } else {
    orderState.quantities[itemId] = currentQty - quantity;
  }

  orderState.total = orderState.items.reduce((sum, id) => {
    const menuItem = MENU_ITEMS.find((m) => m.id === id);
    return sum + menuItem.price * (orderState.quantities[id] || 0);
  }, 0);
  orderState.total = Math.round(orderState.total * 100) / 100;

  const menuItem = MENU_ITEMS.find((m) => m.id === itemId);

  return {
    success: true,
    removed: {
      itemId,
      name: menuItem ? menuItem.name : itemId,
      quantityRemoved,
      removedEntirely,
    },
    cart: {
      items: orderState.items.map((id) => ({
        itemId: id,
        name: MENU_ITEMS.find((m) => m.id === id).name,
        quantity: orderState.quantities[id],
        size: orderState.options[id].size,
        options: orderState.options[id].extras,
      })),
      total: orderState.total,
    },
  };
}

function viewCart(orderState) {
  if (orderState.items.length === 0) {
    return { isEmpty: true, items: [], message: "The cart is currently empty." };
  }

  return {
    isEmpty: false,
    items: orderState.items.map((id) => {
      const menuItem = MENU_ITEMS.find((m) => m.id === id);
      const opts = orderState.options[id] || { size: null, extras: [] };
      return {
        itemId: id,
        name: menuItem ? menuItem.name : id,
        quantity: orderState.quantities[id],
        size: opts.size,
        options: opts.extras,
      };
    }),
  };
}

function promotionQualifyingUnitPrices(eligibility, orderState) {
  const hasItemFilter = eligibility.itemIds && eligibility.itemIds.length > 0;
  const hasCategoryFilter = eligibility.categories && eligibility.categories.length > 0;

  const prices = [];
  orderState.items.forEach((id) => {
    const item = MENU_ITEMS.find((m) => m.id === id);
    if (!item) return;

    const matches =
      (!hasItemFilter && !hasCategoryFilter) ||
      (hasItemFilter && eligibility.itemIds.includes(id)) ||
      (hasCategoryFilter && eligibility.categories.includes(item.category));

    if (matches) {
      for (let i = 0; i < (orderState.quantities[id] || 0); i++) {
        prices.push(item.price);
      }
    }
  });
  return prices;
}

function checkPromotionEligibility(promotion, orderState) {
  const eligibility = promotion.eligibility || {};

  if (eligibility.requiresVerification) {
    return {
      eligible: false,
      reason: `requires ${eligibility.requiresVerification.replace("_", " ")} verification, which can't be confirmed through chat`,
    };
  }

  if (eligibility.daysOfWeek && eligibility.daysOfWeek.length > 0) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const today = dayNames[new Date().getDay()];
    if (!eligibility.daysOfWeek.includes(today)) {
      return { eligible: false, reason: `only valid on ${eligibility.daysOfWeek.join(", ")}` };
    }
  }

  if (eligibility.timeWindow) {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = eligibility.timeWindow.start.split(":").map(Number);
    const [endH, endM] = eligibility.timeWindow.end.split(":").map(Number);
    if (nowMinutes < startH * 60 + startM || nowMinutes > endH * 60 + endM) {
      return {
        eligible: false,
        reason: `only valid between ${eligibility.timeWindow.start} and ${eligibility.timeWindow.end}`,
      };
    }
  }

  const qualifyingPrices = promotionQualifyingUnitPrices(eligibility, orderState);
  if (qualifyingPrices.length === 0) {
    return { eligible: false, reason: "no qualifying items in the current order" };
  }

  const minQuantity = eligibility.minQuantity || 1;
  if (qualifyingPrices.length < minQuantity) {
    return {
      eligible: false,
      reason: `requires at least ${minQuantity} qualifying item(s) in the order (currently ${qualifyingPrices.length})`,
    };
  }

  return { eligible: true, qualifyingPrices };
}

function applyPromotion(input, orderState) {
  const { promotionId } = input || {};
  const activePromotions = PROMOTIONS.filter((p) => p.active);

  if (!promotionId) {
    const eligible = activePromotions
      .map((p) => ({ promotion: p, check: checkPromotionEligibility(p, orderState) }))
      .filter(({ check }) => check.eligible)
      .map(({ promotion }) => ({
        id: promotion.id,
        name: promotion.name,
        rule: promotion.rule,
      }));

    return {
      success: true,
      mode: "check",
      eligiblePromotions: eligible,
      message: eligible.length
        ? "These real, active promotions currently qualify. You may mention at most one, and only if relevant — do not apply it without the customer agreeing."
        : "No active promotions currently qualify for this order.",
    };
  }

  const promotion = PROMOTIONS.find((p) => p.id === promotionId);
  if (!promotion) {
    return {
      success: false,
      error: "unknown_promotion",
      message: `"${promotionId}" is not a recognized promotion. Never accept or invent a discount code or promotion that isn't in the real promotions list — call this tool with no promotionId to see what's actually available.`,
    };
  }
  if (!promotion.active) {
    return {
      success: false,
      error: "inactive_promotion",
      message: `"${promotion.name}" exists but is not currently active, so it cannot be applied.`,
    };
  }

  const check = checkPromotionEligibility(promotion, orderState);
  if (!check.eligible) {
    return {
      success: false,
      error: "not_eligible",
      message: `The order doesn't currently qualify for "${promotion.name}": ${check.reason}.`,
    };
  }

  let discountAmount = 0;
  if (promotion.discountType === "percentage") {
    const qualifyingSubtotal = check.qualifyingPrices.reduce((sum, p) => sum + p, 0);
    discountAmount = qualifyingSubtotal * (promotion.discountValue / 100);
  } else if (promotion.discountType === "bogo") {
    const cheapestQualifying = Math.min(...check.qualifyingPrices);
    discountAmount = cheapestQualifying * (promotion.discountValue / 100);
  } else if (promotion.discountType === "fixed") {
    discountAmount = promotion.discountValue;
  }

  const subtotal = orderState.items.reduce((sum, id) => {
    const menuItem = MENU_ITEMS.find((m) => m.id === id);
    return sum + menuItem.price * (orderState.quantities[id] || 0);
  }, 0);

  discountAmount = Math.min(discountAmount, subtotal);
  discountAmount = Math.round(discountAmount * 100) / 100;
  const newTotal = Math.round((subtotal - discountAmount) * 100) / 100;

  orderState.discount = {
    promotionId: promotion.id,
    name: promotion.name,
    discountType: promotion.discountType,
    discountValue: promotion.discountValue,
    discountAmount,
  };
  orderState.total = newTotal;

  return {
    success: true,
    mode: "applied",
    discount: orderState.discount,
    cart: {
      items: orderState.items.map((id) => ({
        itemId: id,
        name: MENU_ITEMS.find((m) => m.id === id).name,
        quantity: orderState.quantities[id],
        size: orderState.options[id] ? orderState.options[id].size : null,
        options: orderState.options[id] ? orderState.options[id].extras : [],
      })),
      subtotal: Math.round(subtotal * 100) / 100,
      discountAmount,
      total: newTotal,
    },
  };
}

function setPickupDetails(input, orderState) {
  const { name, pickupTime } = input || {};

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      return {
        success: false,
        error: "invalid_name",
        message: "Name must be a non-empty string.",
      };
    }
    orderState.customer.name = name.trim();
  }

  if (pickupTime !== undefined) {
    if (typeof pickupTime !== "string" || !pickupTime.trim()) {
      return {
        success: false,
        error: "invalid_pickup_time",
        message: "Pickup time must be a non-empty string.",
      };
    }
    orderState.pickupTime = pickupTime.trim();
  }

  if (name !== undefined || pickupTime !== undefined) {
    orderState.orderType = "pickup";
  }

  const missing = [];
  if (!orderState.customer.name) missing.push("name");

  return {
    success: true,
    pickup: {
      orderType: orderState.orderType,
      name: orderState.customer.name,
      pickupTime: orderState.pickupTime,
    },
    missing,
    message: missing.length
      ? `Still need: ${missing.join(", ")}. Ask the customer for this before checkout — pickup time is optional and can be skipped.`
      : "All required pickup details are set. Pickup time is optional and may still be missing.",
  };
}

// Accepts a wide range of real-world formats (spaces, dashes, dots, parens,
// leading +) while rejecting obviously fake input: wrong digit count for any
// real country, or a repeating/sequential pattern (e.g. "1111111111",
// "1234567890") that a customer would never actually have.
function isPlausiblePhoneNumber(raw) {
  const digits = raw.trim().replace(/^\+/, "").replace(/[\s\-.()]/g, "");
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length < 7 || digits.length > 15) return false;
  if (/^(\d)\1+$/.test(digits)) return false;

  let ascending = true;
  let descending = true;
  for (let i = 1; i < digits.length; i++) {
    const prev = Number(digits[i - 1]);
    const cur = Number(digits[i]);
    if ((cur - prev + 10) % 10 !== 1) ascending = false;
    if ((prev - cur + 10) % 10 !== 1) descending = false;
  }
  return !(ascending || descending);
}

// Deliberately loose about format — international addresses vary too much to
// require a house-number-first or single-script convention. Only rejects
// clear non-addresses: placeholders, digit-only strings, and single bare
// words with no number and no punctuation (not enough structure for a
// courier to act on).
const ADDRESS_PLACEHOLDER_PATTERN = /^(n\/?a|none|null|test|asdf+|xxx+|unknown|tbd|address|123+)$/i;

function isPlausibleAddress(raw) {
  const value = raw.trim();
  if (value.length < 4) return false;
  if (ADDRESS_PLACEHOLDER_PATTERN.test(value)) return false;
  if (!/\p{L}/u.test(value)) return false;

  const hasDigit = /\d/.test(value);
  const hasMultipleTokens = /[\s,]/.test(value);
  return hasDigit || hasMultipleTokens;
}

function setDeliveryDetails(input, orderState) {
  const { name, phone, address, aptUnit, deliveryInstructions } = input || {};

  const stringFields = { name, phone, address, aptUnit, deliveryInstructions };
  for (const [field, value] of Object.entries(stringFields)) {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      return {
        success: false,
        error: "invalid_field",
        message: `${field} must be a non-empty string.`,
      };
    }
  }

  if (phone !== undefined && !isPlausiblePhoneNumber(phone)) {
    return {
      success: false,
      error: "invalid_phone",
      message:
        "That doesn't look like a real phone number. Ask the customer to re-enter it, ideally with a country or area code.",
    };
  }

  if (address !== undefined && !isPlausibleAddress(address)) {
    return {
      success: false,
      error: "invalid_address",
      message:
        "That doesn't look like a real delivery address. Ask the customer for their full address (street, city, etc.).",
    };
  }

  if (name !== undefined) orderState.customer.name = name.trim();
  if (phone !== undefined) orderState.customer.phone = phone.trim();
  if (address !== undefined) orderState.deliveryAddress = address.trim();
  if (aptUnit !== undefined) orderState.aptUnit = aptUnit.trim();
  if (deliveryInstructions !== undefined) orderState.deliveryInstructions = deliveryInstructions.trim();

  if (Object.values(stringFields).some((v) => v !== undefined)) {
    orderState.orderType = "delivery";
  }

  const missing = [];
  if (!orderState.customer.name) missing.push("name");
  if (!orderState.customer.phone) missing.push("phone");
  if (!orderState.deliveryAddress) missing.push("address");

  return {
    success: true,
    delivery: {
      orderType: orderState.orderType,
      name: orderState.customer.name,
      phone: orderState.customer.phone,
      address: orderState.deliveryAddress,
      aptUnit: orderState.aptUnit,
      deliveryInstructions: orderState.deliveryInstructions,
    },
    missing,
    message: missing.length
      ? `Still need: ${missing.join(", ")}. Ask the customer for this before checkout — never guess it. Apartment/unit and delivery instructions are optional.`
      : "All required delivery details are set. Apartment/unit and delivery instructions are optional and may still be missing.",
  };
}

function calculateOrderTotal(orderState) {
  const subtotal = orderState.items.reduce((sum, id) => {
    const menuItem = MENU_ITEMS.find((m) => m.id === id);
    return sum + (menuItem ? menuItem.price * (orderState.quantities[id] || 0) : 0);
  }, 0);

  let discount = null;
  let discountNote = null;

  if (orderState.discount) {
    const promotion = PROMOTIONS.find((p) => p.id === orderState.discount.promotionId);
    const stillValid = promotion && promotion.active && checkPromotionEligibility(promotion, orderState).eligible;

    if (stillValid) {
      let discountAmount = 0;
      const check = checkPromotionEligibility(promotion, orderState);
      if (promotion.discountType === "percentage") {
        const qualifyingSubtotal = check.qualifyingPrices.reduce((sum, p) => sum + p, 0);
        discountAmount = qualifyingSubtotal * (promotion.discountValue / 100);
      } else if (promotion.discountType === "bogo") {
        const cheapestQualifying = Math.min(...check.qualifyingPrices);
        discountAmount = cheapestQualifying * (promotion.discountValue / 100);
      } else if (promotion.discountType === "fixed") {
        discountAmount = promotion.discountValue;
      }
      discountAmount = Math.min(discountAmount, subtotal);
      discountAmount = Math.round(discountAmount * 100) / 100;

      discount = { promotionId: promotion.id, name: promotion.name, discountAmount };
    } else {
      discountNote =
        "The previously applied promotion no longer qualifies for the current order and was not counted — let the customer know if relevant.";
    }
  }

  const discountAmount = discount ? discount.discountAmount : 0;
  const discountedSubtotal = Math.round((subtotal - discountAmount) * 100) / 100;

  const taxAmount = Math.round(discountedSubtotal * TAX_RATE * 100) / 100;
  const deliveryFee = orderState.orderType === "delivery" ? DELIVERY_FEE : 0;

  const total = Math.round((discountedSubtotal + taxAmount + deliveryFee) * 100) / 100;

  orderState.total = total;

  return {
    success: true,
    breakdown: {
      subtotal: Math.round(subtotal * 100) / 100,
      discount,
      taxRate: TAX_RATE,
      taxAmount,
      orderType: orderState.orderType,
      deliveryFee,
      total,
    },
    ...(discountNote ? { note: discountNote } : {}),
  };
}

function getOrderSummary(orderState) {
  const items = orderState.items.map((id) => {
    const menuItem = MENU_ITEMS.find((m) => m.id === id);
    const opts = orderState.options[id] || { size: null, extras: [] };
    return {
      itemId: id,
      name: menuItem ? menuItem.name : id,
      quantity: orderState.quantities[id],
      size: opts.size,
      options: opts.extras,
    };
  });

  let fulfillment;
  if (orderState.orderType === "pickup") {
    fulfillment = {
      type: "pickup",
      name: orderState.customer.name,
      pickupTime: orderState.pickupTime,
      missing: orderState.customer.name ? [] : ["name"],
    };
  } else if (orderState.orderType === "delivery") {
    const missing = [];
    if (!orderState.customer.name) missing.push("name");
    if (!orderState.customer.phone) missing.push("phone");
    if (!orderState.deliveryAddress) missing.push("address");
    fulfillment = {
      type: "delivery",
      name: orderState.customer.name,
      phone: orderState.customer.phone,
      address: orderState.deliveryAddress,
      aptUnit: orderState.aptUnit,
      deliveryInstructions: orderState.deliveryInstructions,
      missing,
    };
  } else {
    fulfillment = { type: null, missing: ["orderType (pickup or delivery)"] };
  }

  const pricingResult = calculateOrderTotal(orderState);

  const missingSomething = items.length === 0 || fulfillment.missing.length > 0;
  const readyForCheckout = !missingSomething;

  return {
    success: true,
    items,
    fulfillment,
    promotion: pricingResult.breakdown.discount,
    pricing: {
      subtotal: pricingResult.breakdown.subtotal,
      taxRate: pricingResult.breakdown.taxRate,
      taxAmount: pricingResult.breakdown.taxAmount,
      deliveryFee: pricingResult.breakdown.deliveryFee,
      total: pricingResult.breakdown.total,
    },
    ...(pricingResult.note ? { promotionNote: pricingResult.note } : {}),
    readyForCheckout,
    message: readyForCheckout
      ? "Complete order summary — read this back to the customer exactly and get their explicit confirmation before finalizing."
      : items.length === 0
      ? "Cart is empty — there's nothing to summarize yet."
      : `Still missing before checkout: ${fulfillment.missing.join(", ")}.`,
  };
}

function confirmOrder(orderState) {
  const summary = getOrderSummary(orderState);

  if (!summary.readyForCheckout) {
    return {
      success: false,
      error: "not_ready",
      message: `The order can't be confirmed yet: ${summary.message}`,
    };
  }

  let orderRecord;

  try {
    const orders = readOrders();
    const existingIndex = orderState.savedOrderId
      ? orders.findIndex((o) => o.orderId === orderState.savedOrderId)
      : -1;

    if (existingIndex !== -1) {
      orderRecord = {
        ...orders[existingIndex],
        status: "NEW",
        items: summary.items,
        fulfillment: summary.fulfillment,
        promotion: summary.promotion,
        pricing: summary.pricing,
        updatedAt: new Date().toISOString(),
      };
      orders[existingIndex] = orderRecord;
    } else {
      orderRecord = {
        orderId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        status: "NEW",
        items: summary.items,
        fulfillment: summary.fulfillment,
        promotion: summary.promotion,
        pricing: summary.pricing,
      };
      orders.push(orderRecord);
    }

    writeOrders(orders);
  } catch (err) {
    console.error("Failed to save confirmed order:", err);
    return {
      success: false,
      error: "save_failed",
      message: "There was a technical problem saving the order. Tell the customer and ask them to try confirming again.",
    };
  }

  orderState.confirmed = true;
  orderState.status = "confirmed";
  orderState.savedOrderId = orderRecord.orderId;

  const wasUpdate = Boolean(orderRecord.updatedAt);

  return {
    success: true,
    confirmed: true,
    orderId: orderRecord.orderId,
    updated: wasUpdate,
    summary: {
      items: summary.items,
      fulfillment: summary.fulfillment,
      promotion: summary.promotion,
      pricing: summary.pricing,
    },
    message: wasUpdate
      ? "The existing saved order was updated with these changes — same order ID as before. Tell the customer their order was updated, not that a new one was placed. Full checkout/payment submission still isn't available yet."
      : "Order confirmed, saved, and locked in — share the order ID with the customer. Full checkout/payment submission still isn't available yet.",
  };
}

async function executeTool(name, input, orderState) {
  const wasConfirmed = orderState.confirmed;
  let result;

  if (name === "getMenu") {
    result = AVAILABLE_MENU_ITEMS;
  } else if (name === "addItemToCart") {
    result = addItemToCart(input, orderState);
  } else if (name === "modifyItem") {
    result = modifyItem(input, orderState);
  } else if (name === "removeItem") {
    result = removeItem(input, orderState);
  } else if (name === "viewCart") {
    result = viewCart(orderState);
  } else if (name === "applyPromotion") {
    result = applyPromotion(input, orderState);
  } else if (name === "setPickupDetails") {
    result = setPickupDetails(input, orderState);
  } else if (name === "setDeliveryDetails") {
    result = setDeliveryDetails(input, orderState);
  } else if (name === "calculateOrderTotal") {
    result = calculateOrderTotal(orderState);
  } else if (name === "getOrderSummary") {
    result = getOrderSummary(orderState);
  } else if (name === "confirmOrder") {
    result = confirmOrder(orderState);
  } else {
    result = { error: `Unknown tool: ${name}` };
  }

  const succeeded = !result || typeof result !== "object" || result.success !== false;
  if (wasConfirmed && ORDER_MUTATING_TOOLS.has(name) && succeeded) {
    orderState.confirmed = false;
    orderState.status = "building";
  }

  return JSON.stringify(result);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

app.post("/api/chat", async (req, res) => {
  const { message, conversationHistory } = req.body;

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  const orderState = getOrderState(req, res);

  const messages = [
    ...(Array.isArray(conversationHistory) ? conversationHistory : []),
    { role: "user", content: message },
  ];

  try {
    let response;
    while (true) {
      response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 16000,
        // Two stable, request-invariant blocks (system prompt + full menu) —
        // the breakpoint on the last one caches both, plus `tools` (which
        // renders before `system`), in a single prefix. See the comment
        // above MENU_CONTEXT_TEXT: both blocks must stay byte-identical
        // across requests for this to actually hit the cache.
        system: [
          { type: "text", text: SYSTEM_PROMPT },
          { type: "text", text: MENU_CONTEXT_TEXT, cache_control: { type: "ephemeral" } },
        ],
        tools,
        messages,
      });

      console.log(
        `[cache] input_tokens=${response.usage.input_tokens} ` +
          `cache_creation_input_tokens=${response.usage.cache_creation_input_tokens ?? 0} ` +
          `cache_read_input_tokens=${response.usage.cache_read_input_tokens ?? 0}`
      );

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") break;

      const toolUseBlocks = response.content.filter(
        (block) => block.type === "tool_use"
      );

      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(toolUse.name, toolUse.input, orderState);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    const textBlock = response.content.find((block) => block.type === "text");

    res.json({
      reply: textBlock ? textBlock.text : "Sorry, I couldn't come up with a reply.",
      conversationHistory: messages,
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("Claude API authentication error:", error.message);
    } else if (error instanceof Anthropic.RateLimitError) {
      console.error("Claude API rate limited:", error.message);
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}:`, error.message);
    } else {
      console.error("Unexpected error calling Claude API:", error);
    }

    res.status(500).json({
      reply:
        "Sorry, I'm having trouble thinking right now. Please try again in a moment.",
      error: "chat_failed",
    });
  }
});

const STAFF_ORDER_STATUSES = ["NEW", "PREPARING", "READY", "COMPLETED"];

// Staff auth: a single shared password (STAFF_PASSWORD) gates the dashboard.
// Sessions are a signed, stateless cookie (payload + HMAC using STAFF_PASSWORD
// as the key) rather than an in-memory session store — this is deliberate:
// orderSessions above shows how an in-memory Map breaks on Vercel, since a
// later request can land on a different function instance with no shared
// memory. A signed cookie needs no shared state to verify, so it works the
// same way locally and on serverless.
const STAFF_PASSWORD = process.env.STAFF_PASSWORD;
const STAFF_SESSION_COOKIE_NAME = "cafebot_staff_session";
const STAFF_SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours

function signStaffSession(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const signature = crypto.createHmac("sha256", STAFF_PASSWORD).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

function verifyStaffSession(token) {
  if (!STAFF_PASSWORD || !token || typeof token !== "string") return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;

  const expectedSignature = crypto.createHmac("sha256", STAFF_PASSWORD).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
  } catch {
    return false;
  }
  return typeof payload.exp === "number" && payload.exp > Date.now();
}

function getStaffSessionToken(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${STAFF_SESSION_COOKIE_NAME}=`));
  return match ? match.split("=")[1] : null;
}

function requireStaffAuth(req, res, next) {
  if (!verifyStaffSession(getStaffSessionToken(req))) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  next();
}

app.post("/api/staff/login", (req, res) => {
  if (!STAFF_PASSWORD) {
    console.error("STAFF_PASSWORD is not set; staff login is disabled.");
    return res.status(500).json({ error: "Staff login is not configured." });
  }

  const { password } = req.body;
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Password is required." });
  }

  const passwordBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(STAFF_PASSWORD);
  const isValid =
    passwordBuf.length === expectedBuf.length && crypto.timingSafeEqual(passwordBuf, expectedBuf);

  if (!isValid) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  const token = signStaffSession({ exp: Date.now() + STAFF_SESSION_TTL_MS });
  res.cookie(STAFF_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: !!process.env.VERCEL,
    maxAge: STAFF_SESSION_TTL_MS,
  });
  res.json({ success: true });
});

app.post("/api/staff/logout", (req, res) => {
  res.clearCookie(STAFF_SESSION_COOKIE_NAME);
  res.json({ success: true });
});

app.get("/api/staff/session", (req, res) => {
  res.json({ authenticated: verifyStaffSession(getStaffSessionToken(req)) });
});

app.get("/api/orders", requireStaffAuth, (req, res) => {
  try {
    res.json(readOrders());
  } catch (err) {
    console.error("Failed to read orders:", err);
    res.status(500).json({ error: "Failed to read orders." });
  }
});

app.patch("/api/orders/:orderId/status", requireStaffAuth, (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;

  if (!STAFF_ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${STAFF_ORDER_STATUSES.join(", ")}` });
  }

  try {
    const orders = readOrders();
    const order = orders.find((o) => o.orderId === orderId);
    if (!order) {
      return res.status(404).json({ error: `No order with id "${orderId}".` });
    }
    order.status = status;
    order.updatedAt = new Date().toISOString();
    writeOrders(orders);
    res.json(order);
  } catch (err) {
    console.error("Failed to update order status:", err);
    res.status(500).json({ error: "Failed to update order status." });
  }
});

app.get("/api/menu", (req, res) => {
  res.json(AVAILABLE_MENU_ITEMS);
});

app.get("/api/brand", (req, res) => {
  res.json(BRAND_CONFIG);
});

// Vercel (and other serverless platforms) import this file as a handler and
// invoke the exported app directly per-request — they never run this file as
// a script, so app.listen() must not run there. Only bind to a port when this
// file is executed directly (`node server.js` / `npm start`), for local dev.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`${BRAND_CONFIG.cafeName} server running at http://localhost:${PORT}`);
  });
}

module.exports = app;

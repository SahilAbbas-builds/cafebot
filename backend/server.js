const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory only — no database. Cleared whenever the server restarts.
const SESSION_COOKIE_NAME = "cafebot_session";
const orderSessions = new Map(); // sessionId -> order state

function createOrderState() {
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

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "..", "prompts", "system-prompt.md"),
  "utf-8"
);
const MENU_ITEMS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "menu.json"), "utf-8")
);
const PROMOTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "promotions.json"), "utf-8")
);

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

async function executeTool(name, input, orderState) {
  if (name === "getMenu") {
    const activeItems = MENU_ITEMS.filter((item) => item.available);
    return JSON.stringify(activeItems);
  }
  if (name === "addItemToCart") {
    return JSON.stringify(addItemToCart(input, orderState));
  }
  if (name === "modifyItem") {
    return JSON.stringify(modifyItem(input, orderState));
  }
  if (name === "removeItem") {
    return JSON.stringify(removeItem(input, orderState));
  }
  if (name === "viewCart") {
    return JSON.stringify(viewCart(orderState));
  }
  if (name === "applyPromotion") {
    return JSON.stringify(applyPromotion(input, orderState));
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` });
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
        model: "claude-sonnet-5",
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

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

app.listen(PORT, () => {
  console.log(`CafeBot server running at http://localhost:${PORT}`);
});

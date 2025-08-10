const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

// --- ENV ---
// Set these in Render → Dashboard → your service → Environment
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // sk_live_...
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
// e.g. "https://sliprezi-reserve-final.tiiny.site,https://sliprezi.com"
const SUCCESS_URL = process.env.SUCCESS_URL || "https://sliprezi.com/payment-success";
const CANCEL_URL  = process.env.CANCEL_URL  || "https://sliprezi.com/payment-cancelled";

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// CORS allowlist
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow same-origin / curl
    if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  }
}));
app.use(express.json());

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Create Stripe Checkout Session (auth-only)
app.post("/create-checkout-session", async (req, res) => {
  try {
    const {
      amount_cents,           // already in cents from frontend
      currency = "usd",
      location = "",
      city = "",
      state = "",
      email = "",
      hours = "1",
      arrivalDate = "",
      arrivalTime = ""
    } = req.body || {};

    const amount = Number.isFinite(Number(amount_cents)) ? Math.max(50, Math.floor(Number(amount_cents))) : 0;
    if (!amount) return res.status(400).json({ error: "Invalid amount_cents" });

    const name = `Reserved Slip — ${location}${(city || state) ? ` (${[city, state].filter(Boolean).join(", ")})` : ""}`;
    const description = `Arrival: ${arrivalDate} ${arrivalTime} • Duration: ${hours} hour(s)`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_intent_data: { capture_method: "manual" }, // authorize only
      customer_email: email,
      line_items: [{
        price_data: {
          currency,
          product_data: { name, description },
          unit_amount: amount // use as-is; do NOT multiply again
        },
        quantity: 1
      }],
      metadata: { location, city, state, hours, arrivalDate, arrivalTime },
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Listen on Render's assigned port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stripe backend listening on ${PORT}`));

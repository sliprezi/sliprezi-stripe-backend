// server.js (CommonJS)
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

// ---------- ENV ----------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // sk_...
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Full URL to your confirmation page or domain root (we'll append query params)
const CONFIRM_URL = process.env.CONFIRM_URL
  || "https://sliprezi-reservation-confirmation.tiiny.site";

// Where your profile pages live (for cancel back)
const PROFILE_URL_BASE = process.env.PROFILE_URL_BASE
  || "https://sliprezi-master-final.tiiny.site";

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const app = express();

// ---------- CORS ----------
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow same-origin / curl
    if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  }
}));
app.use(express.json());

// ---------- Health ----------
app.get("/", (req, res) => res.status(200).send("OK"));

// ---------- Create Checkout Session (authorize only) ----------
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
      arrivalTime = "",       // 12h label
      reservation_id = ""
    } = req.body || {};

    // Validate amount (min 50 cents)
    const amount = Number.isFinite(Number(amount_cents))
      ? Math.max(50, Math.floor(Number(amount_cents)))
      : 0;
    if (!amount) return res.status(400).json({ error: "Invalid amount_cents" });

    // Build success/cancel URLs
    const qs = new URLSearchParams({
      session_id: "{CHECKOUT_SESSION_ID}",
      ...(reservation_id ? { reservation_id } : {}),
      ...(location ? { location } : {})
    }).toString();

    const successUrl = `${CONFIRM_URL}${CONFIRM_URL.includes("?") ? "&" : "?"}${qs}`;
    const cancelUrl  = `${PROFILE_URL_BASE}/${encodeURIComponent(location)}.html?payment=cancelled`;

    // Idempotency: reuse same session if same reservation_id is sent repeatedly
    const options = reservation_id ? { idempotencyKey: `checkout_${reservation_id}` } : {};

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      payment_method_types: ["card"],
      client_reference_id: reservation_id || undefined, // nice for dashboard/search
      payment_intent_data: {
        capture_method: "manual", // authorize now, capture after approval
        metadata: { location, city, state, hours, arrivalDate, arrivalTime, reservation_id }
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amount,
          product_data: {
            name: `Reserved Slip — ${location}`,
            description: `${[city, state].filter(Boolean).join(", ")} — ${arrivalDate} ${arrivalTime} • ${hours} hour(s)`
          }
        }
      }],
      success_url: successUrl,
      cancel_url: cancelUrl
    }, options);

    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ error: "create_session_failed" });
  }
});

// ---------- Lookup session for confirm page ----------
app.get("/checkout-session", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "missing_session_id" });

    const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ["payment_intent", "customer"] });
    const pi = session.payment_intent;

    const out = {
      id: session.id,
      customer_email: session.customer_details?.email || session.customer_email || "",
      amount_total: session.amount_total,      // cents
      currency: session.currency,
      payment_status: session.payment_status,  // may show "paid" pre-capture
      pi_status: pi?.status,                   // "requires_capture" when auth-only
      captured: pi?.charges?.data?.[0]?.captured || false,
      authorization_last4: pi?.charges?.data?.[0]?.payment_method_details?.card?.last4 || "",
      location: pi?.metadata?.location || "",
      city: pi?.metadata?.city || "",
      state: pi?.metadata?.state || "",
      hours: pi?.metadata?.hours || "",
      arrivalDate: pi?.metadata?.arrivalDate || "",
      arrivalTime: pi?.metadata?.arrivalTime || "",
      reservation_id: pi?.metadata?.reservation_id || ""
    };

    res.json(out);
  } catch (err) {
    console.error("checkout-session error:", err);
    res.status(500).json({ error: "lookup_failed" });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stripe backend listening on ${PORT}`));

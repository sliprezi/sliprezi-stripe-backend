// server.js
const express = require('express');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

app.use(express.json());
app.use(cors());

// Create Stripe Checkout session with manual capture
app.post('/create-checkout-session', async (req, res) => {
  const { amount, boaterName, boaterEmail, locationName } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      payment_intent_data: {
        capture_method: 'manual',
        metadata: {
          boaterName,
          locationName
        }
      },
      customer_email: boaterEmail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Reserved Slip at ${locationName}`,
            },
            unit_amount: amount * 100,
          },
          quantity: 1,
        }
      ],
      success_url: 'https://sliprezi-reserve-final.tiiny.site/success.html',
      cancel_url: 'https://sliprezi-reserve-final.tiiny.site/cancel.html',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe session creation failed:', error);
    res.status(500).json({ error: 'Unable to create Stripe session' });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

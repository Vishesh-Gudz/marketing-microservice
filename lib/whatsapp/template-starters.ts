/**
 * Ready-made WhatsApp templates for the template builder (ADR 0020): the messages businesses send
 * most, written to pass Meta's review. Each one is a starting point: the admin edits the text,
 * replaces the website link and phone number with their own, and submits it; Meta reviews it and
 * may change its category.
 *
 * Writing rules followed here (Meta's template guidelines): every variable is named, has a
 * realistic sample, sits inside a sentence (never at the very start or end of the body) and never
 * next to another variable; utility templates are about something the customer did or asked for,
 * with no promotion; marketing templates offer a way to opt out ("Stop promotions"), which
 * arrives in the inbox as a reply.
 */

export type StarterUseCase = "orders" | "appointments" | "payments" | "support" | "marketing";

export type StarterButton =
  | { type: "QUICK_REPLY"; text: string }
  /** `url` ends in `{{1}}` when the link carries a value, with its `example`. */
  | { type: "URL"; text: string; url: string; example?: string }
  /** `phoneNumber` is left empty: the business enters its own. */
  | { type: "PHONE_NUMBER"; text: string; phoneNumber: string };

export type TemplateStarter = {
  id: string;
  title: string;
  description: string;
  useCase: StarterUseCase;
  category: "UTILITY" | "MARKETING";
  /** The template name it suggests (lowercase letters, digits and `_`). */
  name: string;
  header?: string;
  body: string;
  footer?: string;
  buttons: StarterButton[];
  /** A sample for every variable (Meta requires one per variable). */
  samples: Record<string, string>;
};

/** The placeholder website in starters; the builder asks for the business's own link. */
export const PLACEHOLDER_WEBSITE = "https://your-website.com";

export const USE_CASE_LABELS: Readonly<Record<StarterUseCase, string>> = {
  orders: "Orders and delivery",
  appointments: "Appointments and bookings",
  payments: "Payments and invoices",
  support: "Support and account",
  marketing: "Marketing and engagement",
};

const STOP: StarterButton = { type: "QUICK_REPLY", text: "Stop promotions" };

export const TEMPLATE_STARTERS: readonly TemplateStarter[] = [
  // Orders and delivery (utility)
  {
    id: "order_confirmation",
    title: "Order confirmation",
    description: "Confirm a new order with its number and total, and link to the order page.",
    useCase: "orders",
    category: "UTILITY",
    name: "order_confirmation",
    header: "Order confirmed",
    body: "Hi {{customer_name}}, thank you for your order! Your order {{order_number}} for {{order_total}} has been confirmed. We will message you again as soon as it ships.",
    buttons: [
      {
        type: "URL",
        text: "View order",
        url: `${PLACEHOLDER_WEBSITE}/orders/{{1}}`,
        example: "10234",
      },
    ],
    samples: { customer_name: "Priya", order_number: "#10234", order_total: "₹1,499" },
  },
  {
    id: "order_shipped",
    title: "Shipping update",
    description:
      "Tell the customer the order has shipped, with the carrier, delivery date and tracking.",
    useCase: "orders",
    category: "UTILITY",
    name: "order_shipped",
    header: "Your order is on its way",
    body: "Hi {{customer_name}}, good news! Your order {{order_number}} has shipped with {{carrier}} and should arrive by {{delivery_date}}. You can follow it with the button below.",
    buttons: [
      {
        type: "URL",
        text: "Track order",
        url: `${PLACEHOLDER_WEBSITE}/track/{{1}}`,
        example: "AWB123456789",
      },
    ],
    samples: {
      customer_name: "Priya",
      order_number: "#10234",
      carrier: "Delhivery",
      delivery_date: "12 November",
    },
  },
  {
    id: "out_for_delivery",
    title: "Out for delivery",
    description: "Let the customer know the order arrives today.",
    useCase: "orders",
    category: "UTILITY",
    name: "out_for_delivery",
    body: "Hi {{customer_name}}, your order {{order_number}} is out for delivery today. Please keep your phone nearby so our delivery partner can reach you.",
    buttons: [],
    samples: { customer_name: "Priya", order_number: "#10234" },
  },
  {
    id: "order_delivered",
    title: "Delivery confirmation",
    description: "Confirm delivery and invite the customer to reply if something is wrong.",
    useCase: "orders",
    category: "UTILITY",
    name: "order_delivered",
    body: "Hi {{customer_name}}, your order {{order_number}} has been delivered. We hope you love it! If anything is not right, reply to this message and we will help.",
    buttons: [
      { type: "QUICK_REPLY", text: "All good" },
      { type: "QUICK_REPLY", text: "I need help" },
    ],
    samples: { customer_name: "Priya", order_number: "#10234" },
  },
  {
    id: "order_cancelled",
    title: "Order cancellation",
    description: "Confirm a cancelled order and when the refund arrives.",
    useCase: "orders",
    category: "UTILITY",
    name: "order_cancelled",
    body: "Hi {{customer_name}}, your order {{order_number}} has been cancelled. Any amount you paid will be refunded to your original payment method within {{refund_days}} business days.",
    buttons: [],
    samples: { customer_name: "Priya", order_number: "#10234", refund_days: "5" },
  },
  {
    id: "refund_processed",
    title: "Refund processed",
    description: "Tell the customer a refund was issued and how long it takes.",
    useCase: "orders",
    category: "UTILITY",
    name: "refund_processed",
    body: "Hi {{customer_name}}, we have processed a refund of {{refund_amount}} for order {{order_number}}. It can take 5 to 7 business days to appear in your account.",
    buttons: [],
    samples: { customer_name: "Priya", refund_amount: "₹1,499", order_number: "#10234" },
  },

  // Appointments and bookings (utility)
  {
    id: "appointment_reminder",
    title: "Appointment reminder",
    description:
      "Remind the customer of an upcoming appointment; they confirm or ask to reschedule.",
    useCase: "appointments",
    category: "UTILITY",
    name: "appointment_reminder",
    header: "Appointment reminder",
    body: "Hi {{customer_name}}, this is a reminder of your appointment on {{appointment_date}} at {{appointment_time}}. Please reply below to confirm, or let us know if you need to reschedule.",
    buttons: [
      { type: "QUICK_REPLY", text: "Confirm" },
      { type: "QUICK_REPLY", text: "Reschedule" },
    ],
    samples: {
      customer_name: "Rahul",
      appointment_date: "12 November",
      appointment_time: "4:30 PM",
    },
  },
  {
    id: "appointment_confirmed",
    title: "Appointment confirmation",
    description: "Confirm a booked appointment, with a button to call you.",
    useCase: "appointments",
    category: "UTILITY",
    name: "appointment_confirmed",
    body: "Hi {{customer_name}}, your appointment for {{service_name}} is booked for {{appointment_date}} at {{appointment_time}}. We look forward to seeing you.",
    buttons: [{ type: "PHONE_NUMBER", text: "Call us", phoneNumber: "" }],
    samples: {
      customer_name: "Rahul",
      service_name: "a haircut",
      appointment_date: "12 November",
      appointment_time: "4:30 PM",
    },
  },
  {
    id: "booking_confirmation",
    title: "Booking confirmation",
    description: "Confirm a reservation (hotel, travel, event) with its reference.",
    useCase: "appointments",
    category: "UTILITY",
    name: "booking_confirmation",
    header: "Booking confirmed",
    body: "Hi {{customer_name}}, your booking {{booking_reference}} is confirmed for {{booking_date}}. Please show this message at check-in, and reply here if you have any questions.",
    buttons: [],
    samples: { customer_name: "Anita", booking_reference: "BK-58213", booking_date: "20 December" },
  },

  // Payments and invoices (utility)
  {
    id: "payment_reminder",
    title: "Payment reminder",
    description: "A polite reminder that an invoice is due, with a link to pay.",
    useCase: "payments",
    category: "UTILITY",
    name: "payment_reminder",
    body: "Hi {{customer_name}}, this is a friendly reminder that invoice {{invoice_number}} for {{amount}} is due on {{due_date}}. Please ignore this message if you have already paid.",
    buttons: [
      {
        type: "URL",
        text: "Pay now",
        url: `${PLACEHOLDER_WEBSITE}/pay/{{1}}`,
        example: "INV-2041",
      },
    ],
    samples: {
      customer_name: "Vikram",
      invoice_number: "INV-2041",
      amount: "₹4,800",
      due_date: "15 November",
    },
  },
  {
    id: "payment_received",
    title: "Payment received",
    description: "Thank the customer for a payment and confirm the invoice it paid.",
    useCase: "payments",
    category: "UTILITY",
    name: "payment_received",
    body: "Hi {{customer_name}}, we have received your payment of {{amount}} for invoice {{invoice_number}}. Thank you for paying on time!",
    buttons: [],
    samples: { customer_name: "Vikram", amount: "₹4,800", invoice_number: "INV-2041" },
  },
  {
    id: "payment_failed",
    title: "Payment failed",
    description: "Let the customer know a payment did not go through, with a link to try again.",
    useCase: "payments",
    category: "UTILITY",
    name: "payment_failed",
    body: "Hi {{customer_name}}, your payment of {{amount}} for order {{order_number}} did not go through. You can try again with the button below, or reply here if you need help.",
    buttons: [
      {
        type: "URL",
        text: "Try again",
        url: `${PLACEHOLDER_WEBSITE}/pay/{{1}}`,
        example: "10234",
      },
    ],
    samples: { customer_name: "Vikram", amount: "₹1,499", order_number: "#10234" },
  },

  // Support and account (utility)
  {
    id: "support_ticket_update",
    title: "Support request update",
    description: "Update the customer on a support request and invite a reply.",
    useCase: "support",
    category: "UTILITY",
    name: "support_ticket_update",
    body: "Hi {{customer_name}}, there is an update on your support request {{ticket_number}}: {{ticket_status}}. Reply to this message if you need anything else.",
    buttons: [],
    samples: {
      customer_name: "Meera",
      ticket_number: "#4471",
      ticket_status: "a replacement has been sent",
    },
  },
  {
    id: "account_update",
    title: "Account change alert",
    description: "Alert the customer that a detail of their account was changed.",
    useCase: "support",
    category: "UTILITY",
    name: "account_update",
    body: "Hi {{customer_name}}, the {{changed_detail}} on your account was updated on {{change_date}}. If you did not make this change, please reply to this message right away.",
    buttons: [],
    samples: { customer_name: "Meera", changed_detail: "email address", change_date: "3 November" },
  },

  // Marketing and engagement
  {
    id: "welcome_message",
    title: "Welcome message",
    description: "Welcome a new customer or subscriber and start the conversation.",
    useCase: "marketing",
    category: "MARKETING",
    name: "welcome_message",
    body: "Hi {{customer_name}}, welcome and thank you for joining us! Reply to this message any time with a question, or tap below to see what is new.",
    buttons: [{ type: "QUICK_REPLY", text: "Show me offers" }, STOP],
    samples: { customer_name: "Priya" },
  },
  {
    id: "promotional_offer",
    title: "Special offer",
    description: "Share a discount code with its expiry date and a link to your shop.",
    useCase: "marketing",
    category: "MARKETING",
    name: "special_offer",
    header: "A special offer for you",
    body: "Hi {{customer_name}}, enjoy {{discount}} off your next purchase with the code {{promo_code}}. The offer is valid until {{expiry_date}}, so don't miss out!",
    buttons: [STOP, { type: "URL", text: "Shop now", url: `${PLACEHOLDER_WEBSITE}/shop` }],
    samples: {
      customer_name: "Priya",
      discount: "20%",
      promo_code: "WELCOME20",
      expiry_date: "30 November",
    },
  },
  {
    id: "abandoned_cart",
    title: "Abandoned cart reminder",
    description: "Remind a customer of the items left in their cart.",
    useCase: "marketing",
    category: "MARKETING",
    name: "abandoned_cart",
    body: "Hi {{customer_name}}, you left {{product_name}} in your cart. It is still waiting for you, so complete your order before it sells out.",
    buttons: [STOP, { type: "URL", text: "Complete order", url: `${PLACEHOLDER_WEBSITE}/cart` }],
    samples: { customer_name: "Priya", product_name: "the Linen Shirt" },
  },
  {
    id: "back_in_stock",
    title: "Back in stock",
    description: "Tell interested customers that a product is available again.",
    useCase: "marketing",
    category: "MARKETING",
    name: "back_in_stock",
    body: "Hi {{customer_name}}, good news! {{product_name}} is back in stock. Order now while supplies last.",
    buttons: [STOP, { type: "URL", text: "Shop now", url: `${PLACEHOLDER_WEBSITE}/shop` }],
    samples: { customer_name: "Priya", product_name: "The Classic Tote" },
  },
  {
    id: "new_arrivals",
    title: "New arrivals",
    description: "Announce a new collection or product line.",
    useCase: "marketing",
    category: "MARKETING",
    name: "new_arrivals",
    header: "New arrivals are here",
    body: "Hi {{customer_name}}, our new {{collection_name}} collection has just arrived. Be among the first to explore it.",
    buttons: [STOP, { type: "URL", text: "Explore", url: `${PLACEHOLDER_WEBSITE}/new` }],
    samples: { customer_name: "Priya", collection_name: "winter" },
  },
  {
    id: "feedback_request",
    title: "Feedback request",
    description: "Ask how a visit or purchase went; the answer arrives in your inbox.",
    useCase: "marketing",
    category: "MARKETING",
    name: "feedback_request",
    body: "Hi {{customer_name}}, thank you for choosing us! How was your experience with {{service_name}}? Tap an answer below, we read every response.",
    buttons: [
      { type: "QUICK_REPLY", text: "Excellent" },
      { type: "QUICK_REPLY", text: "Good" },
      { type: "QUICK_REPLY", text: "Could be better" },
      STOP,
    ],
    samples: { customer_name: "Rahul", service_name: "your recent order" },
  },
  {
    id: "win_back",
    title: "We miss you",
    description: "Bring back a customer who has not ordered in a while, with an offer.",
    useCase: "marketing",
    category: "MARKETING",
    name: "we_miss_you",
    body: "Hi {{customer_name}}, it has been a while! Here is {{discount}} off your next order with the code {{promo_code}}, valid until {{expiry_date}}. We would love to see you again.",
    buttons: [STOP, { type: "URL", text: "Shop now", url: `${PLACEHOLDER_WEBSITE}/shop` }],
    samples: {
      customer_name: "Priya",
      discount: "15%",
      promo_code: "COMEBACK15",
      expiry_date: "30 November",
    },
  },
  {
    id: "event_invitation",
    title: "Event invitation",
    description: "Invite customers to an event or sale and collect replies.",
    useCase: "marketing",
    category: "MARKETING",
    name: "event_invitation",
    body: "Hi {{customer_name}}, you are invited to {{event_name}} on {{event_date}} at {{event_location}}. Tap below to let us know if you can make it.",
    buttons: [
      { type: "QUICK_REPLY", text: "Count me in" },
      { type: "QUICK_REPLY", text: "Not this time" },
      STOP,
    ],
    samples: {
      customer_name: "Priya",
      event_name: "our festive sale preview",
      event_date: "18 November",
      event_location: "our Bandra store",
    },
  },
];

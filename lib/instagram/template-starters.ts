/**
 * Ready-made Instagram templates (ADR 0022): the rich messages businesses send most in DMs. Each
 * is a starting point the team edits before saving: its own words instead of anything in
 * [brackets], and its own website instead of the example link (the builder asks for both).
 * `{{customer_name}}` is filled in with the customer's first name when sent.
 *
 * The content types are written out here (the shape of v1/instagramTemplates) so a Convex test
 * can check every starter against the server's rules.
 */

type StarterButton = { type: "url"; title: string; url: string } | { type: "reply"; title: string };
type StarterCard = {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  linkUrl?: string;
  buttons: StarterButton[];
};
export type StarterContent =
  | { kind: "buttons"; text: string; buttons: StarterButton[] }
  | { kind: "cards"; cards: StarterCard[] };

export type InstagramTemplateStarter = {
  id: string;
  group: "basics" | "orders" | "bookings" | "sales" | "support";
  /** The template name it suggests. */
  name: string;
  description: string;
  content: StarterContent;
};

export const STARTER_GROUP_LABELS: Readonly<Record<InstagramTemplateStarter["group"], string>> = {
  basics: "Greetings and help",
  orders: "Orders and delivery",
  bookings: "Bookings",
  sales: "Products and offers",
  support: "Support and feedback",
};

const SITE = "https://your-website.com";
const reply = (title: string): StarterButton => ({ type: "reply", title });
const link = (title: string, path = ""): StarterButton => ({
  type: "url",
  title,
  url: `${SITE}${path}`,
});

export const INSTAGRAM_TEMPLATE_STARTERS: readonly InstagramTemplateStarter[] = [
  {
    id: "welcome_menu",
    group: "basics",
    name: "Welcome menu",
    description: "Greet a new customer and let them pick what they need with one tap.",
    content: {
      kind: "buttons",
      text: "Hi {{customer_name}}, thanks for messaging us! What can we help you with today?",
      buttons: [reply("See prices"), reply("Order status"), reply("Talk to a person")],
    },
  },
  {
    id: "faq_menu",
    group: "basics",
    name: "Frequent questions",
    description: "Offer the questions you are asked most as buttons.",
    content: {
      kind: "buttons",
      text: "Here are the questions we get most. Tap one, or just type your own question.",
      buttons: [reply("Opening hours"), reply("Delivery"), reply("Returns")],
    },
  },
  {
    id: "store_locations",
    group: "basics",
    name: "Our stores",
    description: "Show your locations as cards with directions.",
    content: {
      kind: "cards",
      cards: [
        {
          title: "[Store name]",
          subtitle: "[Street, city] · Open [opening hours]",
          buttons: [link("Get directions", "/stores")],
        },
        {
          title: "[Second store name]",
          subtitle: "[Street, city] · Open [opening hours]",
          buttons: [link("Get directions", "/stores")],
        },
      ],
    },
  },
  {
    id: "visit_website",
    group: "basics",
    name: "Visit our website",
    description: "Close a chat by pointing to your website for news and new arrivals.",
    content: {
      kind: "buttons",
      text: "Thanks for chatting with us, {{customer_name}}! Find our latest news and new arrivals on our website.",
      buttons: [link("Visit our website")],
    },
  },
  {
    id: "order_status",
    group: "orders",
    name: "Track an order",
    description: "Send customers to your tracking page when they ask where their order is.",
    content: {
      kind: "buttons",
      text: "You can follow your order at any time on our tracking page. Have your order number ready.",
      buttons: [link("Track my order", "/track"), reply("Talk to a person")],
    },
  },
  {
    id: "shipping_info",
    group: "orders",
    name: "Shipping information",
    description: "Answer delivery times and costs, with a link to the details.",
    content: {
      kind: "buttons",
      text: "We ship within [2-3] working days, and delivery is free on orders over [amount].",
      buttons: [link("Shipping details", "/shipping"), reply("Order status")],
    },
  },
  {
    id: "return_policy",
    group: "orders",
    name: "Returns",
    description: "Explain your return policy and where to start a return.",
    content: {
      kind: "buttons",
      text: "You can return any item within [30] days of delivery. Start a return on our website and we will guide you through it.",
      buttons: [link("Start a return", "/returns"), reply("Talk to a person")],
    },
  },
  {
    id: "book_appointment",
    group: "bookings",
    name: "Book an appointment",
    description: "Invite the customer to choose a time on your booking page.",
    content: {
      kind: "buttons",
      text: "Book your visit in a few taps, {{customer_name}}. Choose a time that suits you on our booking page.",
      buttons: [link("Book now", "/book"), reply("Ask a question")],
    },
  },
  {
    id: "services_menu",
    group: "bookings",
    name: "Our services",
    description: "Show your services as cards, each with its own booking button.",
    content: {
      kind: "cards",
      cards: [
        {
          title: "[Service 1]",
          subtitle: "[Duration] · [Price]",
          buttons: [link("Book", "/book"), reply("Ask about this")],
        },
        {
          title: "[Service 2]",
          subtitle: "[Duration] · [Price]",
          buttons: [link("Book", "/book"), reply("Ask about this")],
        },
        {
          title: "[Service 3]",
          subtitle: "[Duration] · [Price]",
          buttons: [link("Book", "/book"), reply("Ask about this")],
        },
      ],
    },
  },
  {
    id: "product_carousel",
    group: "sales",
    name: "Product picks",
    description: "Show a few products as swipeable cards with a picture, price and buttons.",
    content: {
      kind: "cards",
      cards: [
        {
          title: "[Product 1]",
          subtitle: "[Price] · [One line about it]",
          buttons: [link("View product", "/products"), reply("I want this")],
        },
        {
          title: "[Product 2]",
          subtitle: "[Price] · [One line about it]",
          buttons: [link("View product", "/products"), reply("I want this")],
        },
        {
          title: "[Product 3]",
          subtitle: "[Price] · [One line about it]",
          buttons: [link("View product", "/products"), reply("I want this")],
        },
      ],
    },
  },
  {
    id: "pricing",
    group: "sales",
    name: "Prices",
    description: "Answer “how much?” with a starting price and your pricing page.",
    content: {
      kind: "buttons",
      text: "Our prices start at [price]. You can see every option on our pricing page.",
      buttons: [link("See prices", "/pricing"), reply("Ask a question")],
    },
  },
  {
    id: "offer",
    group: "sales",
    name: "Current offer",
    description: "Share an offer with a customer who is already chatting with you.",
    content: {
      kind: "buttons",
      text: "Good timing, {{customer_name}}! Right now: [offer]. Use the code [CODE] at checkout.",
      buttons: [link("Shop the offer", "/offers")],
    },
  },
  {
    id: "payment_link",
    group: "sales",
    name: "Pay for an order",
    description: "Send the link to pay once the customer has decided.",
    content: {
      kind: "buttons",
      text: "Thanks for your order, {{customer_name}}! You can pay securely on our checkout page.",
      buttons: [link("Pay now", "/checkout"), reply("I have a question")],
    },
  },
  {
    id: "talk_to_person",
    group: "support",
    name: "A person will reply",
    description: "Let the customer know a team member is on it, with your help pages meanwhile.",
    content: {
      kind: "buttons",
      text: "A member of our team will reply here shortly. Meanwhile, you may find your answer in our help center.",
      buttons: [link("Help center", "/help")],
    },
  },
  {
    id: "feedback",
    group: "support",
    name: "Feedback",
    description: "Ask how it went once the customer's question is solved.",
    content: {
      kind: "buttons",
      text: "How did we do, {{customer_name}}? Your feedback helps us improve.",
      buttons: [reply("Great"), reply("Okay"), reply("Not good")],
    },
  },
];

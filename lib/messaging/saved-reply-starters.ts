/** The channels a saved reply is for (as v1/savedReplies; kept here so a Convex test can read this file). */
type SavedReplyChannel = "whatsapp" | "instagram";

/**
 * Ready-made saved replies (ADR 0021): the answers businesses send most in DMs and chats. Each
 * is a starting point the team edits (the opening hours, the address, the links) before saving.
 * `{{customer_name}}` is filled in with the customer's first name when inserted. Instagram ones
 * may carry quick-reply buttons (the customer taps instead of typing).
 */

export type SavedReplyStarter = {
  id: string;
  group: "basics" | "orders" | "bookings" | "sales" | "instagram";
  title: string;
  text: string;
  channels: SavedReplyChannel[];
  quickReplies?: string[];
};

export const STARTER_GROUP_LABELS: Readonly<Record<SavedReplyStarter["group"], string>> = {
  basics: "Greetings and basics",
  orders: "Orders and delivery",
  bookings: "Bookings",
  sales: "Prices and offers",
  instagram: "Instagram",
};

const BOTH: SavedReplyChannel[] = ["whatsapp", "instagram"];

export const SAVED_REPLY_STARTERS: readonly SavedReplyStarter[] = [
  {
    id: "welcome",
    group: "basics",
    title: "Welcome",
    text: "Hi {{customer_name}}, thanks for reaching out! How can we help you today?",
    channels: BOTH,
    quickReplies: ["Prices", "Order status", "Talk to us"],
  },
  {
    id: "away",
    group: "basics",
    title: "Away message",
    text: "Hi {{customer_name}}, thanks for your message! We're away right now and will reply as soon as we're back, usually within a few hours.",
    channels: BOTH,
  },
  {
    id: "opening_hours",
    group: "basics",
    title: "Opening hours",
    text: "We're open Monday to Saturday, 10 AM to 8 PM, and closed on Sundays. Is there anything we can help you with now?",
    channels: BOTH,
  },
  {
    id: "location",
    group: "basics",
    title: "Location and directions",
    text: "You can find us at [your address]. Here's the map: [map link]. Parking is available nearby. See you soon!",
    channels: BOTH,
  },
  {
    id: "contact_details",
    group: "basics",
    title: "Contact details",
    text: "You can reach us at [phone number] or [email address], or simply reply here. We're happy to help!",
    channels: BOTH,
  },
  {
    id: "thanks",
    group: "basics",
    title: "Thank you",
    text: "Thank you, {{customer_name}}! It was a pleasure helping you. Message us any time.",
    channels: BOTH,
  },
  {
    id: "order_status",
    group: "orders",
    title: "Order status request",
    text: "Hi {{customer_name}}, happy to check! Please share your order number and we'll update you right away.",
    channels: BOTH,
  },
  {
    id: "shipping_times",
    group: "orders",
    title: "Shipping times",
    text: "Orders ship within 1–2 business days and usually arrive in 3–5 business days. You'll get a tracking link as soon as yours ships.",
    channels: BOTH,
  },
  {
    id: "returns",
    group: "orders",
    title: "Returns and exchanges",
    text: "You can return or exchange items within 7 days of delivery, unused and with their tags. Reply with your order number and we'll guide you through it.",
    channels: BOTH,
  },
  {
    id: "payment_options",
    group: "orders",
    title: "Payment options",
    text: "We accept UPI, cards, net banking and cash on delivery. Let us know if you have any questions about paying.",
    channels: BOTH,
  },
  {
    id: "out_of_stock",
    group: "orders",
    title: "Out of stock",
    text: "Sorry, {{customer_name}}, that item is out of stock right now. Would you like us to message you as soon as it's back?",
    channels: BOTH,
    quickReplies: ["Yes, let me know", "No, thanks"],
  },
  {
    id: "booking",
    group: "bookings",
    title: "Booking an appointment",
    text: "We'd love to see you! Which day and time suit you best? Reply with your preference and we'll confirm your slot.",
    channels: BOTH,
    quickReplies: ["Today", "Tomorrow", "This weekend"],
  },
  {
    id: "booking_confirmed",
    group: "bookings",
    title: "Booking confirmed",
    text: "You're booked, {{customer_name}}! We look forward to seeing you. Reply here if you need to change anything.",
    channels: BOTH,
  },
  {
    id: "reschedule",
    group: "bookings",
    title: "Rescheduling",
    text: "No problem, we can move your appointment. Which new day and time would work for you?",
    channels: BOTH,
  },
  {
    id: "price_list",
    group: "sales",
    title: "Price list",
    text: "Here's our price list: [link]. Let us know what you're interested in and we'll help you choose.",
    channels: BOTH,
  },
  {
    id: "current_offer",
    group: "sales",
    title: "Current offer",
    text: "Good timing, {{customer_name}}! You get [discount] off with the code [code] until [date]. Shop here: [link]",
    channels: BOTH,
  },
  {
    id: "bulk_orders",
    group: "sales",
    title: "Bulk and wholesale orders",
    text: "Yes, we take bulk orders! Please share the products, the quantities and your city, and we'll send you a quote.",
    channels: BOTH,
  },
  {
    id: "story_reply_thanks",
    group: "instagram",
    title: "Thanks for the story reply",
    text: "Thanks for replying to our story, {{customer_name}}! Would you like to know more about it?",
    channels: ["instagram"],
    quickReplies: ["Yes, tell me more", "Prices", "Not now"],
  },
  {
    id: "collaboration",
    group: "instagram",
    title: "Collaboration enquiry",
    text: "Thanks for your interest in working with us! Please share your profile, your audience and what you have in mind, and our team will get back to you.",
    channels: ["instagram"],
  },
  {
    id: "dm_for_details",
    group: "instagram",
    title: "Details from a post",
    text: "Hi {{customer_name}}! Here are the details you asked about: [product, price and link]. Want us to reserve one for you?",
    channels: ["instagram"],
    quickReplies: ["Yes, reserve it", "I have a question"],
  },
];

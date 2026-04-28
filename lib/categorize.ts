import type { BucketKey } from "./types";

const PLAID_TO_BUCKET: Record<string, BucketKey> = {
  // Food & Drink
  FOOD_AND_DRINK_RESTAURANTS: "food",
  FOOD_AND_DRINK_FAST_FOOD: "food",
  FOOD_AND_DRINK_COFFEE: "food",
  FOOD_AND_DRINK_BAR: "food",
  FOOD_AND_DRINK_FOOD_DELIVERY: "food",

  // Groceries
  FOOD_AND_DRINK_GROCERIES: "groceries",
  FOOD_AND_DRINK_SUPERMARKETS_AND_GROCERIES: "groceries",

  // Travel
  TRAVEL_FLIGHTS: "travel",
  TRAVEL_HOTELS_AND_MOTELS: "travel",
  TRAVEL_CAR_RENTAL: "travel",
  TRAVEL_VACATION_RENTALS: "travel",
  TRAVEL_TRAVEL_AGENCIES: "travel",

  // Transport
  TRANSPORTATION_TAXIS_AND_RIDE_SHARING: "transport",
  TRANSPORTATION_PUBLIC_TRANSIT: "transport",
  TRANSPORTATION_GAS_STATIONS: "transport",
  TRANSPORTATION_PARKING: "transport",

  // Utilities
  HOME_IMPROVEMENT_UTILITIES: "utilities",
  GOVERNMENT_AND_NON_PROFIT_UTILITIES: "utilities",
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: "utilities",
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: "utilities",
  RENT_AND_UTILITIES_TELEPHONE: "utilities",
  RENT_AND_UTILITIES_WATER: "utilities",

  // Subscriptions
  ENTERTAINMENT_MUSIC_AND_AUDIO: "subscriptions",
  ENTERTAINMENT_STREAMING_MEDIA: "subscriptions",
  GENERAL_SERVICES_SUBSCRIPTION: "subscriptions",
  SOFTWARE_SUBSCRIPTIONS: "subscriptions",

  // Health
  MEDICAL_DOCTORS_AND_PHYSICIANS: "health",
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: "health",
  MEDICAL_DENTISTS: "health",
  MEDICAL_HOSPITALS: "health",
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: "health",

  // Shopping
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: "shopping",
  GENERAL_MERCHANDISE_DEPARTMENT_STORES: "shopping",
  CLOTHING_AND_ACCESSORIES: "shopping",
  ELECTRONICS: "shopping",

  // Entertainment
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: "entertainment",
  ENTERTAINMENT_CASINOS_AND_GAMBLING: "entertainment",
  ENTERTAINMENT_RECREATION_CENTERS: "entertainment",

  // Education
  GENERAL_SERVICES_EDUCATION: "education",
  EDUCATION_TUITION: "education",
  EDUCATION_BOOKS_AND_SUPPLIES: "education",

  // Income
  INCOME_WAGES: "income",
  INCOME_DIVIDENDS: "income",
  INCOME_INTEREST_EARNED: "income",
  INCOME_RETIREMENT_PENSION: "income",
  INCOME_TAX_REFUND: "income",
  INCOME_UNEMPLOYMENT: "income",
  INCOME_OTHER_INCOME: "income",

  // Transfers & card payments
  TRANSFER_IN_ACCOUNT_TRANSFER: "transfers",
  TRANSFER_IN_DEPOSIT: "transfers",
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: "transfers",
  TRANSFER_IN_SAVINGS: "transfers",
  TRANSFER_IN_OTHER_TRANSFER_IN: "transfers",
  TRANSFER_OUT_ACCOUNT_TRANSFER: "transfers",
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: "transfers",
  TRANSFER_OUT_SAVINGS: "transfers",
  TRANSFER_OUT_WITHDRAWAL: "transfers",
  TRANSFER_OUT_OTHER_TRANSFER_OUT: "transfers",
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: "transfers",
  LOAN_PAYMENTS_CAR_PAYMENT: "transfers",
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: "transfers",
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT: "transfers",
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: "transfers",
  LOAN_PAYMENTS_OTHER_PAYMENT: "transfers",
  BANK_FEES_ATM_FEES: "transfers",
  BANK_FEES_FOREIGN_TRANSACTION_FEES: "transfers",
  BANK_FEES_INSUFFICIENT_FUNDS: "transfers",
  BANK_FEES_INTEREST_CHARGE: "transfers",
  BANK_FEES_OVERDRAFT_FEES: "transfers",
  BANK_FEES_OTHER_BANK_FEES: "transfers",
};

const MERCHANT_KEYWORDS: Array<{ pattern: RegExp; bucket: BucketKey }> = [
  {
    pattern:
      /netflix|spotify|disney\+|hulu|apple tv|youtube premium|amazon prime|crave|tidal/i,
    bucket: "subscriptions",
  },
  {
    pattern: /uber eats|doordash|skip|instacart|grubhub|foodora/i,
    bucket: "food",
  },
  { pattern: /uber|lyft|taxi|bolt/i, bucket: "transport" },
  {
    pattern:
      /airbnb|marriott|hilton|hyatt|sheraton|expedia|booking\.com/i,
    bucket: "travel",
  },
  {
    pattern:
      /loblaws|no frills|sobeys|metro|safeway|walmart|costco|whole foods|t&t/i,
    bucket: "groceries",
  },
  { pattern: /amazon|shopify|etsy|ebay/i, bucket: "shopping" },
  { pattern: /rogers|bell|telus|fido|chatr|freedom mobile/i, bucket: "utilities" },
  { pattern: /enmax|epcor|hydro|fortis|atco/i, bucket: "utilities" },
  {
    pattern: /gym|goodlife|equinox|planet fitness|ymca/i,
    bucket: "health",
  },
  {
    pattern:
      /tim hortons|starbucks|mcdonald|subway|chipotle|burger king|a&w/i,
    bucket: "food",
  },
  { pattern: /payroll|direct deposit|paycheque|paycheck/i, bucket: "income" },
  {
    pattern:
      /amex payment|amex epayment|credit card payment|autopay|interac e-transfer/i,
    bucket: "transfers",
  },
];

export function categorizeTx(
  plaidDetailedCategory: string | null,
  merchantName: string | null
): BucketKey {
  if (plaidDetailedCategory && PLAID_TO_BUCKET[plaidDetailedCategory]) {
    return PLAID_TO_BUCKET[plaidDetailedCategory];
  }

  const nameToCheck = merchantName || "";
  for (const { pattern, bucket } of MERCHANT_KEYWORDS) {
    if (pattern.test(nameToCheck)) return bucket;
  }

  if (plaidDetailedCategory) {
    const lower = plaidDetailedCategory.toLowerCase();
    if (lower.startsWith("income_")) return "income";
    if (lower.startsWith("transfer_") || lower.startsWith("loan_payments_") || lower.startsWith("bank_fees_")) {
      return "transfers";
    }
    if (lower.includes("food") || lower.includes("restaurant")) return "food";
    if (lower.includes("grocer")) return "groceries";
    if (
      lower.includes("travel") ||
      lower.includes("flight") ||
      lower.includes("hotel")
    )
      return "travel";
    if (lower.includes("transport")) return "transport";
    if (
      lower.includes("util") ||
      lower.includes("electric") ||
      lower.includes("water") ||
      lower.includes("phone")
    )
      return "utilities";
    if (
      lower.includes("subscription") ||
      lower.includes("stream")
    )
      return "subscriptions";
    if (
      lower.includes("health") ||
      lower.includes("medical") ||
      lower.includes("pharmacy")
    )
      return "health";
    if (lower.includes("entertainment")) return "entertainment";
    if (lower.includes("education")) return "education";
  }

  return "other";
}

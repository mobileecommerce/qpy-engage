/**
 * Normalise a phone number the way WhatsApp Cloud API wants it: country code
 * plus national number, digits only, no leading plus or zeros.
 *
 * Google returns `internationalPhoneNumber` like "+91 40 1234 5678" when it
 * knows the country, and `nationalPhoneNumber` like "040 1234 5678" otherwise.
 * We prefer the international form and fall back to the default country code.
 */
export function toE164Digits(raw: string | null | undefined, defaultCountryCode: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (hasPlus) {
    // Already international.
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else {
    // National number: drop the trunk prefix (0) and prepend the country code.
    digits = digits.replace(/^0+/, "");
    if (!digits.startsWith(defaultCountryCode) || digits.length <= 10) {
      digits = defaultCountryCode + digits;
    }
  }

  // E.164 allows at most 15 digits; anything under 8 is not a real number.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

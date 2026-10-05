/* Languages VasulBook supports, and which language each Indian state uses by default. Shared by browser and server. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VBLang = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const LANGS = [
    { code: "en", name: "English", native: "English", locale: "en-IN" },
    { code: "hi", name: "Hindi", native: "हिन्दी", locale: "hi-IN" },
    { code: "ta", name: "Tamil", native: "தமிழ்", locale: "ta-IN" },
    { code: "te", name: "Telugu", native: "తెలుగు", locale: "te-IN" },
    { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", locale: "kn-IN" },
    { code: "ml", name: "Malayalam", native: "മലയാളം", locale: "ml-IN" },
    { code: "mr", name: "Marathi", native: "मराठी", locale: "mr-IN" },
    { code: "bn", name: "Bengali", native: "বাংলা", locale: "bn-IN" },
    { code: "gu", name: "Gujarati", native: "ગુજરાતી", locale: "gu-IN" },
    { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", locale: "pa-IN" },
  ];
  // State or union territory -> default language
  const STATES = {
    "Andaman and Nicobar Islands": "hi", "Andhra Pradesh": "te", "Arunachal Pradesh": "en", "Assam": "en", "Bihar": "hi",
    "Chandigarh": "pa", "Chhattisgarh": "hi", "Dadra and Nagar Haveli and Daman and Diu": "gu", "Delhi": "hi", "Goa": "en",
    "Gujarat": "gu", "Haryana": "hi", "Himachal Pradesh": "hi", "Jammu and Kashmir": "hi", "Jharkhand": "hi",
    "Karnataka": "kn", "Kerala": "ml", "Ladakh": "hi", "Lakshadweep": "ml", "Madhya Pradesh": "hi", "Maharashtra": "mr",
    "Manipur": "en", "Meghalaya": "en", "Mizoram": "en", "Nagaland": "en", "Odisha": "en", "Puducherry": "ta",
    "Punjab": "pa", "Rajasthan": "hi", "Sikkim": "en", "Tamil Nadu": "ta", "Telangana": "te", "Tripura": "bn",
    "Uttar Pradesh": "hi", "Uttarakhand": "hi", "West Bengal": "bn",
  };
  const CODES = LANGS.map((l) => l.code);
  const isLang = (c) => CODES.includes(c);
  // Best language for a browser's preferred languages, e.g. ["ta-IN","en"] -> "ta"
  function fromBrowser(list) {
    for (const l of list || []) { const c = String(l).slice(0, 2).toLowerCase(); if (isLang(c)) return c; }
    return "en";
  }
  // Fill {placeholders}
  function fill(str, vars) {
    return String(str ?? "").replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m));
  }
  return { LANGS, STATES, CODES, isLang, fromBrowser, fill };
});

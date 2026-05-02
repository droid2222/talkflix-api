const PROVIDER = process.env.GEO_PROVIDER || "ipapi"; // future: "ipapi" | "other"

export async function lookupIp(ip) {
  // dynamic import so swapping providers later is easy
  const { lookupWithIpapi } = await import("./ipapi.js");
  return lookupWithIpapi(ip);
}
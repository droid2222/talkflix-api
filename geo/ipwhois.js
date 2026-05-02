// geo/ipwhois.js
export async function lookupWithIpWhois(ip) {
    const url = ip
      ? `https://ipwhois.app/json/${encodeURIComponent(ip)}`
      : "https://ipwhois.app/json/";
  
    const res = await fetch(url, { headers: { "User-Agent": "talkflix-api" } });
    if (!res.ok) throw new Error(`ipwhois failed: ${res.status}`);
  
    const j = await res.json();
  
    return {
      city: j.city || null,
      region: j.region || null,
      country: j.country || null,
      countryCode: j.country_code || null,
      lat: j.latitude ? Number(j.latitude) : null,
      lon: j.longitude ? Number(j.longitude) : null,
      provider: "ipwhois",
    };
  }
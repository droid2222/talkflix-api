function isLocalOrPrivateIp(ip) {
    if (!ip) return true;
    const s = String(ip).trim();
  
    if (s === "::1" || s === "127.0.0.1") return true;
    if (s.startsWith("10.")) return true;
    if (s.startsWith("192.168.")) return true;
  
    // 172.16.0.0 – 172.31.255.255
    const m = s.match(/^172\.(\d+)\./);
    if (m) {
      const n = Number(m[1]);
      if (n >= 16 && n <= 31) return true;
    }
  
    // IPv6 local
    if (s.startsWith("fe80:") || s.startsWith("fc") || s.startsWith("fd")) return true;
  
    return false;
  }
  
  export async function lookupWithIpapi(ip) {
    const useIp = ip && !isLocalOrPrivateIp(ip);
  
    const url = useIp
      ? `https://ipapi.co/${encodeURIComponent(ip)}/json/`
      : "https://ipapi.co/json/"; // ← uses server’s public IP
  
    const res = await fetch(url, { headers: { "User-Agent": "talkflix-api" } });
    if (!res.ok) throw new Error(`ipapi failed: ${res.status}`);
  
    const j = await res.json();
  
    return {
      city: j.city || null,
      region: j.region || null,
      country: j.country_name || null,
      countryCode: j.country_code || null,
      lat: j.latitude != null ? Number(j.latitude) : null,
      lon: j.longitude != null ? Number(j.longitude) : null,
      provider: "ipapi",
    };
  }
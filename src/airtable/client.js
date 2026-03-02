export async function airtableFetch(path, { method = "GET", body } = {}) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error("Missing AIRTABLE_TOKEN");

  const res = await fetch(`https://api.airtable.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const txt = await res.text();
  if (!res.ok) {
    console.error("Airtable error body:", txt);
    throw new Error(`Airtable API error ${res.status}: ${txt}`);
  }

  return txt ? JSON.parse(txt) : {};
}
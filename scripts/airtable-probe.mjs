import "dotenv/config";

async function probe() {
  const res = await fetch("https://api.airtable.com/v0/meta/bases", {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
  });

  const txt = await res.text();
  console.log("Status:", res.status);
  console.log(txt);
}

probe().catch(console.error);
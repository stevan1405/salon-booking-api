export function isWithinWorkingHours(workingHoursJson, dateYYYYMMDD, startHHmm, endHHmm) {
  let wh;
  try { wh = JSON.parse(workingHoursJson || "{}"); }
  catch { wh = {}; }

  const day = new Date(`${dateYYYYMMDD}T00:00:00`).getDay(); // 0 Sun .. 6 Sat
  const key = ["sun","mon","tue","wed","thu","fri","sat"][day];
  const windows = Array.isArray(wh[key]) ? wh[key] : [];
  if (windows.length === 0) return false;

  // Compare times as minutes since midnight
  const toMin = (t) => {
    const [h,m] = t.split(":").map(Number);
    return h * 60 + m;
  };

  const s = toMin(startHHmm);
  const e = toMin(endHHmm);

  return windows.some(w => {
    const ws = toMin(w.start);
    const we = toMin(w.end);
    return s >= ws && e <= we;
  });
}
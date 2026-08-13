function isMiscollected(row) {
  if (!row) return false;
  const url = String(row.image_url || row.image_high || "");
  if (/byteeffect|ies\.fe\.effect/i.test(url)) return true;
  const prompt = String(row.prompt || "").trim();
  const hasWorkImage = /dreamina|tb4s082cfz|byteimg/i.test(url);
  if (!hasWorkImage && !row.author && !row.model && prompt.length > 0 && prompt.length <= 24 && !/[,，。;；]/.test(prompt)) {
    return true;
  }
  return false;
}

module.exports = { isMiscollected };

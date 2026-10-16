(function () {
  "use strict";
  const b = document.getElementById("copyUpi");
  if (!b) return;
  b.addEventListener("click", async () => {
    const v = document.getElementById("upiId").textContent;
    try { await navigator.clipboard.writeText(v); } catch {
      const r = document.createRange(); r.selectNodeContents(document.getElementById("upiId"));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand("copy");
    }
    const old = b.textContent; b.textContent = b.dataset.done; setTimeout(() => { b.textContent = old; }, 1800);
  });
})();

// Runs before first paint (classic script in <head>) so the saved theme applies
// without a light/dark flash. No saved choice = follow the OS setting.
(function () {
  try {
    var saved = localStorage.getItem("instagrow-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch (e) {}
})();

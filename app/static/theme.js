(function () {
  "use strict";

  const DAY_START_HOUR = 7;
  const NIGHT_START_HOUR = 19;
  const THEME_COLORS = Object.freeze({
    light: "#f5f6f2",
    dark: "#20211f",
  });

  function themeForLocalTime(now) {
    const hour = now.getHours();
    return hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR ? "light" : "dark";
  }

  function applyTheme() {
    const theme = themeForLocalTime(new Date());
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute("content", THEME_COLORS[theme]);
  }

  applyTheme();
  window.setInterval(applyTheme, 60000);
  window.addEventListener("pageshow", applyTheme);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) applyTheme();
  });
}());

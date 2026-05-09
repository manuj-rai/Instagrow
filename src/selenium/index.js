// Barrel: a single import surface for Selenium-related functions.
module.exports = {
  ...require("./driver"),
  ...require("./dom"),
  ...require("./actions"),
  ...require("./scraper"),
};

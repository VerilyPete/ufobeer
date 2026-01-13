// Custom functions for mixed load test
const storeIds = ['13885', '13888', '13877', '13883', '13881'];

module.exports = {
  generateBeers: (userContext, events, done) => {
    const beers = [];
    const baseId = Date.now();

    for (let i = 0; i < 10; i++) {
      beers.push({
        id: String(baseId + i),
        brew_name: `Artillery Test Beer ${baseId + i}`,
        brewer: "Artillery Brewery",
        brew_description: "A test beer for load testing."
      });
    }

    userContext.vars.beers = beers;
    return done();
  },

  generateBeerIds: (userContext, events, done) => {
    const ids = [];
    const baseId = 7000000;

    for (let i = 0; i < 50; i++) {
      ids.push(String(baseId + Math.floor(Math.random() * 1000)));
    }

    userContext.vars.beerIds = ids;
    return done();
  },

  selectStoreId: (userContext, events, done) => {
    const randomIndex = Math.floor(Math.random() * storeIds.length);
    userContext.vars.storeId = storeIds[randomIndex];
    return done();
  }
};

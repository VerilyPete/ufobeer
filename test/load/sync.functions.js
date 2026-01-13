// Custom functions for sync load test
module.exports = {
  generateBeers: (userContext, events, done) => {
    const beers = [];
    const baseId = Date.now();

    for (let i = 0; i < 10; i++) {
      beers.push({
        id: String(baseId + i),
        brew_name: `Artillery Test Beer ${baseId + i}`,
        brewer: "Artillery Brewery",
        brew_description: "A test beer for load testing with Artillery."
      });
    }

    userContext.vars.beers = beers;
    return done();
  }
};

// Custom functions for batch load test
module.exports = {
  generateBeerIds: (userContext, events, done) => {
    const ids = [];
    const baseId = 7000000;

    // Generate 50 beer IDs (mix of likely existing and random)
    for (let i = 0; i < 50; i++) {
      ids.push(String(baseId + Math.floor(Math.random() * 1000)));
    }

    userContext.vars.beerIds = ids;
    return done();
  }
};

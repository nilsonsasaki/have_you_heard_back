// class Game

module.exports = class Game {

    constructor(gameID) {
        this.id = gameID;
        this.persona = undefined;
        this.players = [];
        this.personaVotes = [];
        this.phrases = [];
        this.answers = [];
    }

};

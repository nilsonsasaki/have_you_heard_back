// Rooms service

const redis = require('redis');
const User = require('./user.class');
const Room = require('./room.class');
const Redis = require('./redis.service');
const Server = require('./server.service');
const Users = require('./users.service');
const Games = require('./games.service');

// The class is given when something requires this module
module.exports = class Rooms {

    static instance = null;

    constructor() {
        this.toDestroy = {}
    }

    static init() {
        if (Rooms.instance == null) {
            Rooms.instance = new Rooms();
        }
    }

    static getInstance() {
        if (Rooms.instance == null) {
            Rooms.init();
        }
        return Rooms.instance;
    }

    static async get(roomID) {
        try {
            let roomJSON = await Redis.get(roomID);
            if (roomJSON) {
                return JSON.parse(roomJSON);
            }
        } catch (e) {
            console.error(e);
        }
        return undefined;
    }

    /**
     * Remove user from a room and add to a new room.
     *
     * oldRoomID and newRoomID can be undefined, but not both at the same time:
     *   - oldRoomID undefined means adding the user to a room
     *   - newRoomID undefined means removing the user from a room
     */
    static async swapRooms(userID, oldRoomID, newRoomID, cb, errCB) {
        let redisIO = Redis.getIO();
        let toWatch = [userID];

        if (oldRoomID == newRoomID) {
            return 'ok';
        }

        if (oldRoomID) {
            toWatch.push(oldRoomID);
        }

        if (newRoomID) {
            toWatch.push(newRoomID);
        }

        // Use redis multi to create transaction:
        // - Remove from old room (if defined)
        // - Reassing old room owner if the user was the owner
        // - Delete old room if empty
        // - Add to new room
        // - Set user room as current room
        // - Store state

        function transaction (attempts) {
            // Watch to prevent conflicts
            redisIO.watch(toWatch, async (watchErr) => {
                try {
                    if (watchErr) throw(watchErr);

                    let userPromise = Users.get(userID);
                    let oldRoomPromise = undefined;
                    let newRoomPromise = undefined;
                    let oldRoom = undefined;
                    let newRoom = undefined;

                    if (oldRoomID) {
                        oldRoomPromise = Rooms.get(oldRoomID);
                    }

                    if (newRoomID) {
                        newRoomPromise = Rooms.get(newRoomID);
                    }

                    let user = await userPromise;
                    if (!user) {
                        throw new Error(`User ${userID} not found`);
                    }

                    // If oldRoomID is not defined but the user was in a room, make
                    // the user leave the room they were
                    if (!oldRoomID && user.room) {
                        toWatch.push(user.room);
                        oldRoomID = user.room;
                        oldRoomPromise = Rooms.get(oldRoomID);
                    }

                    // Remove the user from the old room
                    if (oldRoomID) {
                        oldRoom = await oldRoomPromise;
                        if (!oldRoom) {
                            throw new Error(`Room ${oldRoomID} not found`);
                        }
                        // Remove the user from the old room
                        oldRoom.users = oldRoom.users.filter((value, index, arr) => {
                            return value !== userID;
                        });

                        // If the user was the owner of the old room handover
                        // ownership to the next. If the room is empty, it will be
                        // destroyed.
                        if (oldRoom.ownerID === userID) {
                            if (oldRoom.users.length > 0) {
                                oldRoom.ownerID = oldRoom.users[0];
                                console.log(`User ${oldRoom.owner} is now the owner`);
                            }
                        }

                        user.room = undefined;
                    }

                    // Find new room
                    if (newRoomID) {
                        newRoom = await newRoomPromise;
                        if (!newRoom) {
                            throw new Error(`Room ${newRoomID} not found`);
                        }

                        // Insert the user to the new room
                        if (!newRoom.users.includes(userID)) {
                            newRoom.users.push(userID);
                            if (!newRoom.ownerID) {
                                newRoom.ownerID = userID;
                            }
                        }

                        user.room = newRoomID;
                    }

                    // Create transaction
                    let multi = redisIO.multi();
                    if (oldRoom) {
                        if (oldRoom.users.length <= 0) {
                            // TODO use autodestroy instead of imediately destroying
                            multi.del(oldRoomID, redis.print);
                            console.log(`Room ${oldRoomID} is empty and will be deleted`);
                        } else {
                            multi.set(oldRoomID, JSON.stringify(oldRoom),
                                      redis.print);
                        }
                    }

                    if (newRoom) {
                        multi.set(newRoomID, JSON.stringify(newRoom),
                                   redis.print);
                    }

                    multi.set(userID, JSON.stringify(user), redis.print);

                    multi.exec((err, replies) => {
                        if (err) throw(err);

                        if (replies) {
                            replies.forEach(function(reply, index) {
                                console.log("Swap transaction @" + index + ": " +
                                            reply.toString());
                            });

                            // If a callback was provided, call
                            if (cb) {
                                cb(user, oldRoom, newRoom);
                            }

                        } else {
                            if (attempts > 0) {
                                console.log('Room swap transaction conflict, retrying...');
                                return transaction(--attempts);
                            } else {
                                return undefined;
                            }
                        };
                    });
                } catch(err) {
                    // In case of error call the error callback
                    if (errCB) {
                        errCB(err);
                    } else {
                        console.error(err);
                    }
                }
            });
        }

        // Retry up to 5 times
        let resultPromise = new Promise((resolve, reject) => {
            try {
                transaction(5);
                resolve('ok');
            } catch (err) {
                reject(err);
            }
        });

        return resultPromise;
    }

    /**
     * Create a new room and call the providede callback passing the created
     * room object.
     * */
    static async create(cb, errCB) {
        // Create new object
        let redisIO = Redis.getIO();

        async function transaction(attempts) {

            // Generate 5 digit ID
            let roomID = 'room_' +
                     String(Math.floor(Math.random() * 100000)).padStart(5,'0');

            // Watch to prevent conflicts
            redisIO.watch(roomID, async (watchErr) => {
                try {
                    if (watchErr) throw (watchErr);

                    let exist = await Redis.exists(roomID);
                    if (exist) {
                        // Try again
                        return transaction(--attempts);
                    }

                    // Create transaction
                    let room = new Room(roomID);
                    let multi = redisIO.multi();
                    multi.set(roomID, JSON.stringify(room), redis.print);
                    multi.exec((multiErr, replies) => {
                        if (multiErr) {
                            throw(multiErr);
                        }

                        if (replies) {
                            replies.forEach(function(reply, index) {
                                console.log('Room create transaction: ' + reply.toString());
                            });

                            // In case of success, call the callback, if provided
                            if (cb) {
                                cb(room);
                            }

                            return room;
                        } else {
                            if (attempts > 0) {
                                console.log('Room create transaction conflict, retrying...');
                                return transaction(--attempts);
                            } else {
                                return undefined;
                            }
                        }
                    });
                } catch(err) {
                    if (errCB) {
                        errCB(err);
                    } else {
                        console.error(err);
                    }
                }
            });
        }

        // Retry up to 5 times
        let resultPromise = new Promise((resolve, reject) => {
            try {
                transaction(5);
                resolve('ok');
            } catch(err) {
                reject(err);
            }
        });

        return resultPromise;
    }

    static async addUser(userID, roomID, cb, errCB) {
        return Rooms.swapRooms(userID, undefined, roomID, cb, errCB);
    }

    static async removeUser(userID, roomID, cb, errCB) {
        return Rooms.swapRooms(userID, roomID, undefined, cb, errCB);
    }

    static async destroy(roomID, cb, errCB) {
        let io = Server.getIO();
        let redisIO = Redis.getIO();
        let toWatch = [roomID];

        function transaction (attempts) {
            // User transaction to avoid conflicts
            redisIO.watch(toWatch, async (err, result) => {
                try {
                    if (err) throw(err);

                    let room = await Rooms.get(roomID);
                    if (!room) {
                        throw new Error(`Room ${roomID} not found`);
                    }

                    // Empty rooms can be removed immediately
                    if (room.users.length == 0 ) {
                        return await Redis.del(roomID);
                    }

                    let multi = redisIO.multi();
                    toWatch = toWatch.concat(room.users);

                    // Remove users from the room
                    for (let userID of room.users) {
                        let user = await Users.get(userID);
                        if (user) {
                            user.room = undefined;
                            multi.set(userID, JSON.stringify(user),
                                      redis.print);
                        }
                    }

                    multi.del(roomID, redis.print);
                    multi.exec((err, replies) => {
                        if (err) reject(err);

                        if (replies) {
                            replies.forEach(function(reply, index) {
                                console.log("DESTROY @ index " + index + ": " +
                                            reply.toString());
                            });

                            if (cb) {
                                cb(room);
                            }

                            // TODO put this in the callback
                            io.socketsLeave(roomID);
                        } else {
                            if (attempts > 0) {
                                console.log('Room destroy transaction conflict, retrying...');
                                return transaction(--attempts);
                            } else {
                                return undefined;
                            }

                        }
                    });
                } catch(err) {
                    if (errCB) {
                        errCB(err);
                    } else {
                        console.error(err);
                    }
                }
            });
        }

        // Retry up to 5 times
        let resultPromise = new Promise((resolve, reject) => {
            try {
                transaction(5);
                resolve('ok');
            } catch(err) {
                reject(err);
            }
        });

        return resultPromise;
    }


    /**
     * Complete the room object, getting the user and game state
     * The user can provide callbacks for success and error cases
     * */
    static async complete(room, cb, errCB) {
        if (!room) {
            if (errCB) {
                errCB(new Error('Invalid room object'));
            } else {
                console.error('Invalid room object');
            }
            return undefined;
        }

        let allPromises = [];
        for (let user of room.users) {
            allPromises.push(Users.get(user));
        }

        // If there is a game in progress, obtain it's state
        if (room.game) {
            allPromises.push(Games.get(room.game));
        }

        Promise.all(allPromises).then((values) => {

            if (room.game) {
                room.game = values.pop();
            }

            room.users = values;

            if (cb) {
                cb(room);
            }
        }).catch((err) => {
            if (errCB) {
                errCB(new Error('Invalid room object'));
            } else {
                console.error('Invalid room object');
            }
            return undefined;
        });
    }
};

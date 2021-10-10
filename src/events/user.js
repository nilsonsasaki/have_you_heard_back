// Event: user

const Users = require('../server/users.service');

// Initialize event listener
module.exports = function(socket) {
    socket.on('user', async (id) => {
        //TODO for now, we ignore the provided ID and always create a new user
        console.log(`received user ID from ${socket.id}: ` + id);

        // Create user
        Users.create(`user_${socket.id}`, (user) => {
            if (user) {
                socket.emit('user id', `${user.id}`);

                // Listen to these events
                require('./message')(socket);
                require('./join')(socket);
                require('./leave')(socket);
                require('./new_room')(socket);
                require('./name')(socket);
                require('./start')(socket);
            } else {
                console.error('Could not create user');
            }
        }, (err) => {
            console.error('Could not create user: ' + err);
        });
    });
};

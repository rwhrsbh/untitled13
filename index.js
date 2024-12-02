const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

const PLANT_TYPES = {
    SUNFLOWER: { cost: 50, health: 100, name: 'Sunflower' },
    PEASHOOTER: { cost: 100, health: 100, damage: 20, name: 'Peashooter' }
};

const ZOMBIE_TYPES = {
    BASIC: { health: 100, damage: 10, speed: 0.5, name: 'Basic Zombie' }
};

const games = new Map();

const GAME_UPDATE_INTERVAL = 100;

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createGame', () => {
        const gameId = Math.random().toString(36).substring(7);
        games.set(gameId, {
            plants: [],
            zombies: [],
            sun: 50,
            players: [socket.id],
            status: 'waiting',
            lastUpdate: Date.now()
        });
        socket.join(gameId);
        socket.emit('gameCreated', { gameId });
        console.log('Game created:', gameId);
    });

    socket.on('joinGame', (gameId) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', { message: 'Game not found' });
            return;
        }
        if (game.players.length >= 2) {
            socket.emit('error', { message: 'Game is full' });
            return;
        }

        game.players.push(socket.id);
        game.status = 'playing';
        socket.join(gameId);
        socket.emit('gameJoined', { gameId });
        io.to(gameId).emit('gameStart');

        startGameLoop(gameId);
        console.log('Player joined game:', gameId);
    });

    socket.on('placePlant', (data) => {
        const game = games.get(data.gameId);
        if (!game) return;

        const plantType = PLANT_TYPES[data.type];
        if (!plantType) return;

        if (game.sun >= plantType.cost) {
            game.sun -= plantType.cost;
            game.plants.push({
                type: data.type,
                x: data.x,
                y: data.y,
                health: plantType.health,
                lastShot: Date.now()
            });
            io.to(data.gameId).emit('gameUpdate', game);
            console.log('Plant placed:', data.type, 'at', data.x, data.y);
        }
    });

    socket.on('placeZombie', (data) => {
        const game = games.get(data.gameId);
        if (!game) return;

        const zombieType = ZOMBIE_TYPES[data.type];
        if (!zombieType) return;

        game.zombies.push({
            type: data.type,
            x: data.x,
            y: data.y,
            health: zombieType.health,
            speed: zombieType.speed
        });
        io.to(data.gameId).emit('gameUpdate', game);
        console.log('Zombie placed:', data.type, 'at', data.x, data.y);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        for (const [gameId, game] of games.entries()) {
            if (game.players.includes(socket.id)) {
                io.to(gameId).emit('gameEnded', { reason: 'Player disconnected' });
                games.delete(gameId);
                console.log('Game cleaned up:', gameId);
            }
        }
    });
});

function startGameLoop(gameId) {
    const interval = setInterval(() => {
        const game = games.get(gameId);
        if (!game || game.status !== 'playing') {
            clearInterval(interval);
            return;
        }

        updateGameState(game);
        io.to(gameId).emit('gameUpdate', game);
    }, GAME_UPDATE_INTERVAL);
}

function updateGameState(game) {
    const now = Date.now();
    const deltaTime = (now - game.lastUpdate) / 1000;
    game.lastUpdate = now;

    game.zombies.forEach(zombie => {
        zombie.x -= zombie.speed * deltaTime;
    });

    game.plants.forEach(plant => {
        if (plant.type === 'SUNFLOWER' && Math.random() < 0.1) {
            game.sun += 25;
        }
    });

    game.plants.forEach(plant => {
        if (plant.type === 'PEASHOOTER' && now - plant.lastShot > 2000) {
            const zombiesInRow = game.zombies.filter(z =>
                Math.floor(z.y) === Math.floor(plant.y) && z.x > plant.x
            );

            if (zombiesInRow.length > 0) {
                const closestZombie = zombiesInRow.reduce((closest, current) =>
                    current.x < closest.x ? current : closest
                );
                closestZombie.health -= PLANT_TYPES.PEASHOOTER.damage;
                plant.lastShot = now;
            }
        }
    });

    game.zombies = game.zombies.filter(zombie => zombie.health > 0);

    game.plants = game.plants.filter(plant => plant.health > 0);

    const plantsLost = game.zombies.some(zombie => zombie.x <= 0);
    const zombiesLost = game.zombies.length === 0 && game.status === 'ending';

    if (plantsLost) {
        game.status = 'ended';
        io.to(gameId).emit('gameEnded', { winner: 'zombies' });
    } else if (zombiesLost) {
        game.status = 'ended';
        io.to(gameId).emit('gameEnded', { winner: 'plants' });
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
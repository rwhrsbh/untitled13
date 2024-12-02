// server.js
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

// Game Constants
const GAME_UPDATE_INTERVAL = 50; // 20 updates per second
const PLANT_TYPES = {
    SUNFLOWER: { 
        cost: 50, 
        health: 100, 
        name: 'Sunflower',
        sunGenerationInterval: 20000, // 20 seconds
        sunAmount: 25
    },
    PEASHOOTER: { 
        cost: 100, 
        health: 100, 
        damage: 20, 
        name: 'Peashooter',
        shootInterval: 2000 // 2 seconds
    }
};

const ZOMBIE_TYPES = {
    BASIC: { 
        health: 100, 
        damage: 10, 
        speed: 0.5, 
        name: 'Basic Zombie',
        attackInterval: 1000 // 1 second
    }
};

// Store active games
const games = new Map();

// Game cleanup interval (5 minutes)
const CLEANUP_INTERVAL = 300000;
setInterval(() => {
    const now = Date.now();
    for (const [gameId, game] of games.entries()) {
        if (now - game.lastUpdate > CLEANUP_INTERVAL) {
            games.delete(gameId);
            console.log(`Cleaned up inactive game: ${gameId}`);
        }
    }
}, CLEANUP_INTERVAL);

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createGame', () => {
        const gameId = Math.random().toString(36).substring(7);
        const newGame = {
            plants: [],
            zombies: [],
            sun: 50,
            players: [socket.id],
            status: 'waiting',
            lastUpdate: Date.now(),
            score: {
                plants: 0,
                zombies: 0
            },
            gameLoop: null
        };
        
        games.set(gameId, newGame);
        socket.join(gameId);
        socket.emit('gameCreated', { gameId });
        console.log('Game created:', gameId);
    });

    socket.on('joinGame', (gameId) => {
        const game = games.get(gameId);
        
        if (!game) {
            socket.emit('error', { message: 'Game not found!' });
            return;
        }
        
        if (game.players.length >= 2) {
            socket.emit('error', { message: 'Game is full!' });
            return;
        }
        
        if (game.status !== 'waiting') {
            socket.emit('error', { message: 'Game already in progress!' });
            return;
        }

        game.players.push(socket.id);
        game.status = 'playing';
        socket.join(gameId);
        socket.emit('gameJoined', { gameId });
        io.to(gameId).emit('gameStart');
        
        // Start game loop
        startGameLoop(gameId);
        console.log('Player joined game:', gameId);
    });

    socket.on('placePlant', (data) => {
        const game = games.get(data.gameId);
        if (!game || game.status !== 'playing') return;

        const plantType = PLANT_TYPES[data.type];
        if (!plantType) return;

        // Validate position
        if (data.x < 0 || data.x >= 9 || data.y < 0 || data.y >= 5) {
            socket.emit('error', { message: 'Invalid position!' });
            return;
        }

        // Check if spot is taken
        const isSpotTaken = game.plants.some(plant => 
            Math.floor(plant.x) === Math.floor(data.x) && 
            Math.floor(plant.y) === Math.floor(data.y)
        );

        if (isSpotTaken) {
            socket.emit('error', { message: 'Spot is already taken!' });
            return;
        }

        // Check sun cost
        if (game.sun < plantType.cost) {
            socket.emit('error', { message: 'Not enough sun!' });
            return;
        }

        // Place plant
        game.sun -= plantType.cost;
        game.plants.push({
            type: data.type,
            x: data.x,
            y: data.y,
            health: plantType.health,
            lastShot: Date.now(),
            lastSunGeneration: Date.now()
        });

        io.to(data.gameId).emit('gameUpdate', getGameState(game));
    });

    socket.on('placeZombie', (data) => {
        const game = games.get(data.gameId);
        if (!game || game.status !== 'playing') return;

        const zombieType = ZOMBIE_TYPES[data.type];
        if (!zombieType) return;

        // Validate position (only rightmost column)
        if (data.x !== 8 || data.y < 0 || data.y >= 5) {
            socket.emit('error', { message: 'Invalid position!' });
            return;
        }

        // Place zombie
        game.zombies.push({
            type: data.type,
            x: data.x,
            y: data.y,
            health: zombieType.health,
            speed: zombieType.speed,
            lastAttack: Date.now()
        });

        io.to(data.gameId).emit('gameUpdate', getGameState(game));
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Clean up any games this player was in
        for (const [gameId, game] of games.entries()) {
            if (game.players.includes(socket.id)) {
                io.to(gameId).emit('gameEnded', { 
                    reason: 'Player disconnected',
                    winner: game.players[0] === socket.id ? 'zombies' : 'plants'
                });
                if (game.gameLoop) {
                    clearInterval(game.gameLoop);
                }
                games.delete(gameId);
                console.log('Game cleaned up:', gameId);
            }
        }
    });
});

function startGameLoop(gameId) {
    const game = games.get(gameId);
    if (!game) return;

    game.gameLoop = setInterval(() => {
        updateGameState(game);
        io.to(gameId).emit('gameUpdate', getGameState(game));
    }, GAME_UPDATE_INTERVAL);
}

function updateGameState(game) {
    const now = Date.now();
    const deltaTime = (now - game.lastUpdate) / 1000;
    game.lastUpdate = now;

    // Генерация солнца от подсолнухов (исправлено)
    game.plants.forEach(plant => {
        if (plant.type === 'SUNFLOWER') {
            if (!plant.lastSunGeneration || now - plant.lastSunGeneration >= 20000) {
                game.sun += 25;
                plant.lastSunGeneration = now;
            }
        }
    });

    // Обработка зомби
    game.zombies.forEach(zombie => {
        const collidingPlant = game.plants.find(plant => 
            Math.abs(zombie.x - plant.x) < 0.5 && 
            Math.floor(plant.y) === Math.floor(zombie.y)
        );

        if (collidingPlant) {
            if (now - zombie.lastAttack >= 1000) {
                collidingPlant.health -= ZOMBIE_TYPES[zombie.type].damage;
                zombie.lastAttack = now;
            }
        } else {
            zombie.x -= zombie.speed * deltaTime;
        }
    });

    // Стрельба горохострелов
    game.plants.forEach(plant => {
        if (plant.type === 'PEASHOOTER') {
            if (now - plant.lastShot >= 2000) {
                const zombiesInRow = game.zombies.filter(z => 
                    Math.floor(z.y) === Math.floor(plant.y) && 
                    z.x > plant.x
                );
                
                if (zombiesInRow.length > 0) {
                    const closestZombie = zombiesInRow.reduce((closest, current) => 
                        current.x < closest.x ? current : closest
                    );
                    closestZombie.health -= PLANT_TYPES.PEASHOOTER.damage;
                    plant.lastShot = now;
                }
            }
        }
    });

    // Удаление мертвых юнитов
    game.zombies = game.zombies.filter(zombie => zombie.health > 0);
    game.plants = game.plants.filter(plant => plant.health > 0);

    // Проверка условий победы
    checkWinConditions(game);
}

// Исправляем обработку размещения зомби
socket.on('placeZombie', (data) => {
    const game = games.get(data.gameId);
    if (!game) return;

    // Убираем лишние проверки, оставляем только валидацию позиции по Y
    if (data.y < 0 || data.y >= 5) {
        socket.emit('error', { message: 'Invalid position!' });
        return;
    }

    game.zombies.push({
        type: 'BASIC',
        x: 8, // Всегда ставим в крайний правый столбец
        y: data.y,
        health: ZOMBIE_TYPES.BASIC.health,
        speed: ZOMBIE_TYPES.BASIC.speed,
        lastAttack: Date.now()
    });

    io.to(data.gameId).emit('gameUpdate', getGameState(game));
});

function getGameState(game) {
    return {
        plants: game.plants,
        zombies: game.zombies,
        sun: game.sun,
        score: game.score,
        status: game.status
    };
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

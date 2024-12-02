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
const GAME_UPDATE_INTERVAL = 50;
const PLANT_TYPES = {
    SUNFLOWER: { 
        cost: 50, 
        health: 100, 
        name: 'Sunflower',
        sunGenerationInterval: 20000,
        sunAmount: 25
    },
    PEASHOOTER: { 
        cost: 100, 
        health: 100, 
        damage: 20, 
        name: 'Peashooter',
        shootInterval: 2000
    }
};

const ZOMBIE_TYPES = {
    BASIC: { 
        health: 100, 
        damage: 10, 
        speed: 0.5, 
        name: 'Basic Zombie',
        attackInterval: 1000
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

function checkWinConditions(game) {
    const plantsLost = game.zombies.some(zombie => zombie.x <= 0);
    const zombiesLost = game.zombies.length === 0 && game.plants.length > 0 && game.status === 'playing';

    if (plantsLost) {
        game.status = 'ended';
        game.score.zombies += 1;
        io.to(game.id).emit('gameEnded', { winner: 'zombies', score: game.score });
        if (game.gameLoop) {
            clearInterval(game.gameLoop);
        }
    } else if (zombiesLost) {
        game.status = 'ended';
        game.score.plants += 1;
        io.to(game.id).emit('gameEnded', { winner: 'plants', score: game.score });
        if (game.gameLoop) {
            clearInterval(game.gameLoop);
        }
    }
}

function getGameState(game) {
    return {
        plants: game.plants,
        zombies: game.zombies,
        sun: game.sun,
        score: game.score,
        status: game.status
    };
}

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

    // Update plants
    game.plants.forEach(plant => {
        // Sunflower sun generation
        if (plant.type === 'SUNFLOWER') {
            if (!plant.lastSunGeneration || now - plant.lastSunGeneration >= PLANT_TYPES.SUNFLOWER.sunGenerationInterval) {
                game.sun += PLANT_TYPES.SUNFLOWER.sunAmount;
                plant.lastSunGeneration = now;
            }
        }

        // Peashooter attacks
        if (plant.type === 'PEASHOOTER') {
            if (now - plant.lastShot >= PLANT_TYPES.PEASHOOTER.shootInterval) {
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
        }
    });

    // Update zombies
    game.zombies.forEach(zombie => {
        const collidingPlant = game.plants.find(plant => 
            Math.abs(zombie.x - plant.x) < 0.5 && 
            Math.floor(plant.y) === Math.floor(zombie.y)
        );

        if (collidingPlant) {
            if (now - zombie.lastAttack >= ZOMBIE_TYPES.BASIC.attackInterval) {
                collidingPlant.health -= ZOMBIE_TYPES.BASIC.damage;
                zombie.lastAttack = now;
            }
        } else {
            zombie.x -= ZOMBIE_TYPES.BASIC.speed * deltaTime;
        }
    });

    // Remove dead units
    game.zombies = game.zombies.filter(zombie => zombie.health > 0);
    game.plants = game.plants.filter(plant => plant.health > 0);

    // Check win conditions
    checkWinConditions(game);
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createGame', () => {
        const gameId = Math.random().toString(36).substring(7);
        const newGame = {
            id: gameId,
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
        
        startGameLoop(gameId);
        console.log('Player joined game:', gameId);
    });

    socket.on('placePlant', (data) => {
        const game = games.get(data.gameId);
        if (!game || game.status !== 'playing') return;

        const plantType = PLANT_TYPES[data.type];
        if (!plantType) return;

        if (data.x < 0 || data.x >= 9 || data.y < 0 || data.y >= 5) {
            socket.emit('error', { message: 'Invalid position!' });
            return;
        }

        const isSpotTaken = game.plants.some(plant => 
            Math.floor(plant.x) === Math.floor(data.x) && 
            Math.floor(plant.y) === Math.floor(data.y)
        );

        if (isSpotTaken) {
            socket.emit('error', { message: 'Spot is already taken!' });
            return;
        }

        if (game.sun < plantType.cost) {
            socket.emit('error', { message: 'Not enough sun!' });
            return;
        }

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

        if (data.y < 0 || data.y >= 5) {
            socket.emit('error', { message: 'Invalid position!' });
            return;
        }

        game.zombies.push({
            type: 'BASIC',
            x: 8,
            y: data.y,
            health: ZOMBIE_TYPES.BASIC.health,
            speed: ZOMBIE_TYPES.BASIC.speed,
            lastAttack: Date.now()
        });

        io.to(data.gameId).emit('gameUpdate', getGameState(game));
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
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

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

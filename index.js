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

const WAVE_SYSTEM = {
    POINTS_PER_WAVE: 100,    // Starting points per wave
    POINTS_INCREMENT: 50,     // Points increase per wave
    WAVE_DURATION: 60000,     // Wave duration (60 seconds)
    BREAK_DURATION: 20000,    // Break between waves (20 seconds)
    TOTAL_WAVES: 5           // Waves needed for plant victory
};

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
        cost: 25,
        health: 100, 
        damage: 10, 
        speed: 0.5, 
        name: 'Basic Zombie',
        attackInterval: 1000
    },
    CONE: {
        cost: 50,
        health: 200,
        damage: 10,
        speed: 0.45,
        name: 'Cone Zombie',
        attackInterval: 1000
    },
    BUCKET: {
        cost: 75,
        health: 300,
        damage: 10,
        speed: 0.4,
        name: 'Bucket Zombie',
        attackInterval: 1000
    },
    DOOR: {
        cost: 100,
        health: 400,
        damage: 10,
        speed: 0.35,
        name: 'Door Zombie',
        attackInterval: 1200
    },
    FOOTBALL: {
        cost: 175,
        health: 200,
        damage: 15,
        speed: 0.8,
        name: 'Football Zombie',
        attackInterval: 800
    }
};

const AMBULANCE = {
    speed: 2,
    damage: 1000, // Instant kill for zombies
    width: 120,
    height: 60
};

// Game state for each active game
class Game {
    constructor() {
        this.plants = [];
        this.zombies = [];
        this.sun = 50;
        this.players = [];
        this.status = 'waiting';
        this.currentWave = 0;
        this.wavePoints = WAVE_SYSTEM.POINTS_PER_WAVE;
        this.waveStartTime = 0;
        this.waveStatus = 'break';
        this.lastUpdate = Date.now();
        this.ambulances = this.initAmbulances();
        this.score = { plants: 0, zombies: 0 };
    }

    initAmbulances() {
        return Array(5).fill(null).map((_, row) => ({
            row,
            x: -0.5,
            active: false,
            used: false,
            state: 'idle'
        }));
    }
}

// Store active games
const games = new Map();

// Helper function to get game state for client
function getGameState(game) {
    return {
        plants: game.plants,
        zombies: game.zombies,
        sun: game.sun,
        status: game.status,
        currentWave: game.currentWave,
        waveStatus: game.waveStatus,
        wavePoints: game.wavePoints,
        waveStartTime: game.waveStartTime,
        ambulances: game.ambulances,
        score: game.score
    };
}

// Socket connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createGame', () => {
        const gameId = Math.random().toString(36).substring(7);
        const game = new Game();
        game.players.push(socket.id);
        games.set(gameId, game);
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

        game.players.push(socket.id);
        game.status = 'playing';
        game.waveStartTime = Date.now();
        game.waveStatus = 'active';
        
        socket.join(gameId);
        socket.emit('gameJoined', { gameId });
        io.to(gameId).emit('gameStart');
        
        startGameLoop(gameId);
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
        if (!game || game.status !== 'playing' || game.waveStatus !== 'active') return;

        const zombieType = ZOMBIE_TYPES[data.type || 'BASIC'];
        if (!zombieType) return;

        // Validate position
        if (data.y < 0 || data.y >= 5) {
            socket.emit('error', { message: 'Invalid position!' });
            return;
        }

        // Check points cost
        if (zombieType.cost > game.wavePoints) {
            socket.emit('error', { message: 'Not enough points!' });
            return;
        }

        // Place zombie
        game.wavePoints -= zombieType.cost;
        game.zombies.push({
            type: data.type || 'BASIC',
            x: 8,
            y: data.y,
            health: zombieType.health,
            speed: zombieType.speed,
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
                games.delete(gameId);
            }
        }
    });
});

function startGameLoop(gameId) {
    const interval = setInterval(() => {
        const game = games.get(gameId);
        if (!game || game.status === 'ended') {
            clearInterval(interval);
            return;
        }

        updateGameState(game, gameId);
        io.to(gameId).emit('gameUpdate', getGameState(game));
    }, GAME_UPDATE_INTERVAL);
}

function updateGameState(game, gameId) {
    const now = Date.now();
    const deltaTime = (now - game.lastUpdate) / 1000;
    game.lastUpdate = now;

    // Update wave status
    if (game.waveStatus === 'active') {
        if (now - game.waveStartTime >= WAVE_SYSTEM.WAVE_DURATION) {
            game.waveStatus = 'break';
            game.waveStartTime = now;
        }
    } else if (game.waveStatus === 'break') {
        if (now - game.waveStartTime >= WAVE_SYSTEM.BREAK_DURATION) {
            game.currentWave++;
            if (game.currentWave >= WAVE_SYSTEM.TOTAL_WAVES) {
                // Plants win if all waves completed
                if (game.zombies.length === 0) {
                    endGame(game, 'plants', gameId);
                    return;
                }
            }
            game.wavePoints = WAVE_SYSTEM.POINTS_PER_WAVE + 
                             (game.currentWave * WAVE_SYSTEM.POINTS_INCREMENT);
            game.waveStatus = 'active';
            game.waveStartTime = now;
        }
    }

    // Update ambulances
    game.ambulances.forEach(ambulance => {
        if (ambulance.active && !ambulance.used) {
            ambulance.x += AMBULANCE.speed * deltaTime;
            
            // Check zombie collisions
            game.zombies.forEach(zombie => {
                if (Math.floor(zombie.y) === ambulance.row &&
                    Math.abs(zombie.x - ambulance.x) < 1) {
                    zombie.health = 0;
                }
            });

            // Deactivate ambulance when it reaches the end
            if (ambulance.x > 9) {
                ambulance.used = true;
                ambulance.state = 'used';
            }
        }
    });

    // Update zombies
    game.zombies.forEach(zombie => {
        const zombieType = ZOMBIE_TYPES[zombie.type];
        
        // Find colliding plant
        const collidingPlant = game.plants.find(plant => 
            Math.abs(zombie.x - plant.x) < 0.5 && 
            Math.floor(plant.y) === Math.floor(zombie.y)
        );

        if (collidingPlant) {
            // Attack plant
            if (now - zombie.lastAttack >= zombieType.attackInterval) {
                collidingPlant.health -= zombieType.damage;
                zombie.lastAttack = now;
            }
        } else {
            // Move forward
            zombie.x -= zombie.speed * deltaTime;
            
            // Check if zombie reached the house
            if (zombie.x <= 0) {
                const ambulance = game.ambulances.find(a => 
                    a.row === Math.floor(zombie.y) && !a.used
                );
                if (ambulance) {
                    ambulance.active = true;
                } else {
                    // Zombies win if they reach the house with no ambulance
                    endGame(game, 'zombies', gameId);
                    return;
                }
            }
        }
    });

    // Update plants
    game.plants.forEach(plant => {
        if (plant.type === 'SUNFLOWER') {
            // Generate sun
            if (now - plant.lastSunGeneration >= PLANT_TYPES.SUNFLOWER.sunGenerationInterval) {
                game.sun += PLANT_TYPES.SUNFLOWER.sunAmount;
                plant.lastSunGeneration = now;
            }
        }
        else if (plant.type === 'PEASHOOTER') {
            // Shoot zombies
            if (now - plant.lastShot >= PLANT_TYPES.PEASHOOTER.shootInterval) {
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

    // Remove dead units
    game.zombies = game.zombies.filter(zombie => zombie.health > 0);
    game.plants = game.plants.filter(plant => plant.health > 0);
}

function endGame(game, winner, gameId) {
    game.status = 'ended';
    game.score[winner]++;
    io.to(gameId).emit('gameEnded', { 
        winner: winner,
        score: game.score
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

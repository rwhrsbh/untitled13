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
    POINTS_PER_WAVE: 100,    // Начальные очки на волну
    POINTS_INCREMENT: 50,     // Увеличение очков каждую волну
    WAVE_DURATION: 60000,     // Длительность волны (60 секунд)
    BREAK_DURATION: 20000,    // Перерыв между волнами (20 секунд)
    TOTAL_WAVES: 5           // Количество волн для победы
};

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
    width: 120,
    height: 60,
    speed: 2,
    damage: 1000
};

// Store active games
const games = new Map();

function createNewGame() {
    return {
        plants: [],
        zombies: [],
        sun: 50,
        players: [],
        status: 'waiting',
        lastUpdate: Date.now(),
        currentWave: 0,
        wavePoints: WAVE_SYSTEM.POINTS_PER_WAVE,
        waveStartTime: 0,
        waveStatus: 'break',
        zombieQueue: [],
        score: {
            plants: 0,
            zombies: 0
        },
        ambulances: initAmbulances(),
        gameLoop: null
    };
}

function initAmbulances() {
    const ambulances = [];
    for (let row = 0; row < 5; row++) {
        ambulances.push({
            row: row,
            x: -0.5,
            active: false,
            used: false,
            state: 'idle',
            animationFrame: 0
        });
    }
    return ambulances;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createGame', () => {
        const gameId = Math.random().toString(36).substring(7);
        const newGame = createNewGame();
        newGame.players.push(socket.id);
        
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

        game.players.push(socket.id);
        game.status = 'playing';
        game.waveStartTime = Date.now();
        game.waveStatus = 'active';
        
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
        if (!game || game.status !== 'playing' || game.waveStatus !== 'active') return;

        const zombieType = ZOMBIE_TYPES[data.type];
        if (!zombieType) return;

        if (data.y < 0 || data.y >= 5) {
            socket.emit('error', { message: 'Invalid position!' });
            return;
        }

        if (zombieType.cost > game.wavePoints) {
            socket.emit('error', { message: 'Not enough points!' });
            return;
        }

        game.wavePoints -= zombieType.cost;
        game.zombies.push({
            type: data.type,
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

    // Update wave status
    if (game.waveStatus === 'active') {
        if (now - game.waveStartTime >= WAVE_SYSTEM.WAVE_DURATION) {
            game.waveStatus = 'break';
            game.waveStartTime = now;
        }
    } else if (game.waveStatus === 'break') {
        if (now - game.waveStartTime >= WAVE_SYSTEM.BREAK_DURATION) {
            game.currentWave++;
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

            if (ambulance.x > 9) {
                ambulance.used = true;
                ambulance.state = 'used';
            }
        }
    });

    // Update zombies
    game.zombies.forEach(zombie => {
        const zombieType = ZOMBIE_TYPES[zombie.type];
        
        const collidingPlant = game.plants.find(plant => 
            Math.abs(zombie.x - plant.x) < 0.5 && 
            Math.floor(plant.y) === Math.floor(zombie.y)
        );

        if (collidingPlant) {
            if (now - zombie.lastAttack >= zombieType.attackInterval) {
                collidingPlant.health -= zombieType.damage;
                zombie.lastAttack = now;
            }
        } else {
            zombie.x -= zombie.speed * deltaTime;
            
            // Check if zombie reached the house
            if (zombie.x <= 0) {
                const ambulance = game.ambulances.find(a => 
                    a.row === Math.floor(zombie.y) && !a.used
                );
                if (ambulance) {
                    ambulance.active = true;
                } else {
                    game.status = 'ended';
                    game.score.zombies += 1;
                    io.to(gameId).emit('gameEnded', { winner: 'zombies', score: game.score });
                    clearInterval(game.gameLoop);
                }
            }
        }
    });

    // Update plants
    game.plants.forEach(plant => {
        if (plant.type === 'SUNFLOWER') {
            if (now - plant.lastSunGeneration >= PLANT_TYPES.SUNFLOWER.sunGenerationInterval) {
                game.sun += PLANT_TYPES.SUNFLOWER.sunAmount;
                plant.lastSunGeneration = now;
            }
        }
        else if (plant.type === 'PEASHOOTER') {
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

    // Check win/lose conditions
    checkGameEnd(game);
}

function checkGameEnd(game) {
    // Plants win if all waves are completed and no zombies left
    if (game.currentWave >= WAVE_SYSTEM.TOTAL_WAVES && 
        game.zombies.length === 0 && 
        game.waveStatus === 'break') {
        game.status = 'ended';
        game.score.plants += 1;
        io.to(gameId).emit('gameEnded', { winner: 'plants', score: game.score });
        clearInterval(game.gameLoop);
    }
}

function getGameState(game) {
    return {
        plants: game.plants,
        zombies: game.zombies,
        sun: game.sun,
        score: game.score,
        status: game.status,
        currentWave: game.currentWave,
        waveStatus: game.waveStatus,
        wavePoints: game.wavePoints,
        waveStartTime: game.waveStartTime,
        ambulances: game.ambulances
    };
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

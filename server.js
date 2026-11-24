
const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 9090;

const server = app.listen(PORT, () => {
    console.log(`Servidor iniciado na porta: ${PORT}`);
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

function generateRoomCode(length = 5) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";

    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return result;
}

function sendToRoom(room, command, content = {}) {
    for (const client of Object.values(room.players)) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                cmd: command,
                content
            }));
        }
    }
}

function getRoomPlayerCount(room) {
    return Object.keys(room.players).length;
}

function getReadyCount(room) {
    return room.readyPlayers.size;
}

function sendReadyUpdate(room) {
    sendToRoom(room, "ready_update", {
        ready: getReadyCount(room),
        total: getRoomPlayerCount(room)
    });
}

const playerlist = {
    players: [],

    get(uuid) {
        return this.players.find(player => player.uuid === uuid);
    },

    add(uuid, roomCode) {
        const playersInRoom = this.getByRoom(roomCode);
        const isFirstPlayer = playersInRoom.length === 0;

        const player = {
            uuid,
            room: roomCode,
            x: isFirstPlayer ? 550 : 700,
            y: 300
        };

        this.players.push(player);
        return player;
    },

    update(uuid, newX, newY, newZ, newRY) {
        const player = this.get(uuid);

        if (player) {
            player.x = newX;
            player.y = newY;
            player.z = newZ;
            player.r_y = newRY;
        }
    },

    remove(uuid) {
        this.players = this.players.filter(player => player.uuid !== uuid);
    },

    getByRoom(roomCode) {
        return this.players.filter(player => player.room === roomCode);
    }
};

wss.on("connection", (socket) => {
    const uuid = uuidv4();
    socket.uuid = uuid;

    console.log(`Cliente conectado: ${uuid}`);

    socket.send(JSON.stringify({
        cmd: "joined_server",
        content: { uuid }
    }));

    socket.on("message", (message) => {
        let data;

        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Erro ao interpretar mensagem:", err);
            return;
        }

        const content = data.content || {};

        switch (data.cmd) {

            // ========================
            // CRIAR SALA
            // ========================

            case "create_room": {
                let newRoomId;

                do {
                    newRoomId = generateRoomCode();
                } while (rooms.has(newRoomId));

                socket.roomId = newRoomId;

                const room = {
                    players: {},
                    missionId: null,
                    readyPlayers: new Set(),
                    missionStarted: false
                };

                rooms.set(newRoomId, room);
                room.players[uuid] = socket;

                const newPlayer = playerlist.add(uuid, newRoomId);

                console.log(`Sala ${newRoomId} criada por ${uuid}`);

                socket.send(JSON.stringify({
                    cmd: "room_created",
                    content: { code: newRoomId }
                }));

                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player: newPlayer }
                }));

                break;
            }

            // ========================
            // ENTRAR NA SALA
            // ========================

            case "join_room": {
                const roomCode = String(content.code || "").toUpperCase();
                const roomToJoin = rooms.get(roomCode);

                if (!roomToJoin) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Sala não encontrada." }
                    }));
                    return;
                }

                if (roomToJoin.missionId !== null || roomToJoin.missionStarted) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "A sala já está preparando uma missão." }
                    }));
                    return;
                }

                socket.roomId = roomCode;
                roomToJoin.players[uuid] = socket;

                const newPlayer = playerlist.add(uuid, roomCode);

                console.log(`Jogador ${uuid} entrou na sala ${roomCode}`);

                socket.send(JSON.stringify({
                    cmd: "room_joined",
                    content: { code: roomCode }
                }));

                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player: newPlayer }
                }));

                const roomPlayers = playerlist.getByRoom(roomCode)
                    .filter(player => player.uuid !== uuid);

                socket.send(JSON.stringify({
                    cmd: "spawn_network_players",
                    content: { players: roomPlayers }
                }));

                for (const clientUuid in roomToJoin.players) {
                    const client = roomToJoin.players[clientUuid];

                    if (client !== socket && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            cmd: "spawn_new_player",
                            content: { player: newPlayer }
                        }));
                    }
                }

                // MANTIDO: leva os jogadores do menu ao lobby.
                if (Object.keys(roomToJoin.players).length >= 2) {
                    console.log(`Sala ${roomCode} atingiu o número de jogadores. Começando o jogo!`);

                    for (const clientUuid in roomToJoin.players) {
                        const client = roomToJoin.players[clientUuid];

                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                cmd: "start_game",
                                content: {}
                            }));
                        }
                    }
                }

                break;
            }

            // ========================
            // SELECIONAR MISSÃO
            // ========================

            case "select_mission": {
                const room = rooms.get(socket.roomId);
                const missionId = content.mission_id;

                if (!room || room.missionStarted) return;

                if (typeof missionId !== "string" || missionId.length === 0) {
                    return;
                }

                if (room.missionId === null) {
                    room.missionId = missionId;
                    room.readyPlayers.clear();

                    console.log(`Sala ${socket.roomId} selecionou ${missionId}`);
                } else if (room.missionId !== missionId) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "Outro jogador já selecionou uma missão diferente."
                        }
                    }));
                    return;
                }

                sendToRoom(room, "mission_selected", {
                    mission_id: room.missionId
                });

                sendReadyUpdate(room);
                break;
            }

            // ========================
            // JOGADOR FICA PRONTO
            // ========================

            case "player_ready": {
                const room = rooms.get(socket.roomId);

                if (!room || room.missionStarted || room.missionId === null) {
                    return;
                }

                if (!room.players[uuid]) return;

                room.readyPlayers.add(uuid);

                console.log(
                    `${uuid} está pronto (${getReadyCount(room)}/${getRoomPlayerCount(room)})`
                );

                sendReadyUpdate(room);

                // TODOS OS JOGADORES PRECISAM ESTAR PRONTOS.
                if (
                    getRoomPlayerCount(room) > 0 &&
                    getReadyCount(room) === getRoomPlayerCount(room)
                ) {
                    room.missionStarted = true;

                    console.log(`Iniciando missão ${room.missionId} na sala ${socket.roomId}`);

                    sendToRoom(room, "mission_started", {
                        mission_id: room.missionId
                    });
                }

                break;
            }

            // ========================
            // POSIÇÃO
            // ========================

            case "position": {
                playerlist.update(
                    uuid,
                    content.x,
                    content.y,
                    content.z,
                    content.r_y
                );

                const room = rooms.get(socket.roomId);

                if (room) {
                    for (const clientUuid in room.players) {
                        const client = room.players[clientUuid];

                        if (client !== socket && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                cmd: "update_position",
                                content: {
                                    uuid,
                                    x: content.x,
                                    y: content.y,
                                    z: content.z,
                                    r_y: content.r_y,
                                    moving: content.moving
                                }
                            }));
                        }
                    }
                }

                break;
            }

            // ========================
            // CHAT
            // ========================

            case "chat": {
                const room = rooms.get(socket.roomId);

                if (room) {
                    sendToRoom(room, "new_chat_message", {
                        uuid,
                        msg: content.msg
                    });
                }

                break;
            }
        }
    });

    // ========================
    // DESCONECTAR
    // ========================

    socket.on("close", () => {
        console.log(`Cliente desconectado: ${uuid}`);

        playerlist.remove(uuid);

        const room = rooms.get(socket.roomId);

        if (!room) return;

        delete room.players[uuid];
        room.readyPlayers.delete(uuid);

        for (const clientUuid in room.players) {
            const client = room.players[clientUuid];

            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    cmd: "player_disconnected",
                    content: { uuid }
                }));
            }
        }

        if (getRoomPlayerCount(room) === 0) {
            rooms.delete(socket.roomId);
            console.log(`Sala ${socket.roomId} vazia e removida.`);
            return;
        }

        if (!room.missionStarted && room.missionId !== null) {
            sendReadyUpdate(room);
        }
    });
});
                

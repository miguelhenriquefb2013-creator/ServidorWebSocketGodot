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

// ========================
// UTILITÁRIOS
// ========================

function generateRoomCode(length = 5) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";

    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return result;
}

function sendToSocket(socket, command, content = {}) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ cmd: command, content }));
    }
}

function sendToRoom(room, command, content = {}, exceptSocket = null) {
    for (const client of Object.values(room.players)) {
        if (client !== exceptSocket) {
            sendToSocket(client, command, content);
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

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

// O primeiro jogador da sala controla a IA do Killer.
function setKillerOwner(room, roomCode, uuid) {
    room.killerOwner = uuid;

    console.log(`Controlador do Killer na sala ${roomCode}: ${uuid}`);

    sendToRoom(room, "killer_owner", {
        uuid: room.killerOwner
    });
}

function sendKillerOwnerToPlayer(room, socket) {
    sendToSocket(socket, "killer_owner", {
        uuid: room.killerOwner || ""
    });

    if (room.killerState) {
        sendToSocket(socket, "killer_state", room.killerState);
    }
}

// ========================
// SISTEMA DE JOGADORES
// ========================

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
            y: 300,
            z: 0,
            r_y: 0
        };

        this.players.push(player);
        return player;
    },

    update(uuid, newX, newY, newZ, newRY) {
        const player = this.get(uuid);
        if (!player) return;

        player.x = newX;
        player.y = newY;
        player.z = newZ;
        player.r_y = newRY;
    },

    remove(uuid) {
        this.players = this.players.filter(player => player.uuid !== uuid);
    },

    getByRoom(roomCode) {
        return this.players.filter(player => player.room === roomCode);
    }
};

// ========================
// INICIAR MISSÃO
// ========================

function tryStartMission(room, roomCode) {
    if (!room) return;
    if (room.missionStarted) return;
    if (room.missionId === null) return;

    const total = getRoomPlayerCount(room);
    const ready = getReadyCount(room);

    if (total === 0 || ready !== total) return;

    room.missionStarted = true;

    console.log(`Iniciando missão ${room.missionId} na sala ${roomCode}`);

    sendToRoom(room, "mission_started", {
        mission_id: room.missionId
    });
}

// ========================
// WEBSOCKET
// ========================

wss.on("connection", (socket) => {
    const uuid = uuidv4();
    socket.uuid = uuid;

    console.log(`Cliente conectado: ${uuid}`);
    sendToSocket(socket, "joined_server", { uuid });

    socket.on("message", (message) => {
        let data;

        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Erro ao interpretar mensagem:", err);
            return;
        }

        if (!data || typeof data.cmd !== "string") return;

        const content = data.content || {};

        switch (data.cmd) {
            case "create_room": {
                if (socket.roomId) {
                    sendToSocket(socket, "error", { msg: "Você já está em uma sala." });
                    return;
                }

                let newRoomId;
                do {
                    newRoomId = generateRoomCode();
                } while (rooms.has(newRoomId));

                socket.roomId = newRoomId;

                const room = {
                    players: {},
                    missionId: null,
                    readyPlayers: new Set(),
                    missionStarted: false,
                    lobbyStarted: false,
                    killerOwner: uuid,
                    killerState: null
                };

                rooms.set(newRoomId, room);
                room.players[uuid] = socket;

                const newPlayer = playerlist.add(uuid, newRoomId);

                console.log(`Sala ${newRoomId} criada por ${uuid}`);

                sendToSocket(socket, "room_created", { code: newRoomId });
                sendToSocket(socket, "spawn_local_player", { player: newPlayer });
                sendKillerOwnerToPlayer(room, socket);
                break;
            }

            case "join_room": {
                if (socket.roomId) {
                    sendToSocket(socket, "error", { msg: "Você já está em uma sala." });
                    return;
                }

                const roomCode = String(content.code || "").toUpperCase();
                const roomToJoin = rooms.get(roomCode);

                if (!roomToJoin) {
                    sendToSocket(socket, "error", { msg: "Sala não encontrada." });
                    return;
                }

                if (roomToJoin.missionStarted) {
                    sendToSocket(socket, "error", { msg: "A missão já começou." });
                    return;
                }

                socket.roomId = roomCode;
                roomToJoin.players[uuid] = socket;

                const newPlayer = playerlist.add(uuid, roomCode);

                console.log(`Jogador ${uuid} entrou na sala ${roomCode}`);

                sendToSocket(socket, "room_joined", { code: roomCode });
                sendToSocket(socket, "spawn_local_player", { player: newPlayer });

                const roomPlayers = playerlist
                    .getByRoom(roomCode)
                    .filter(player => player.uuid !== uuid);

                sendToSocket(socket, "spawn_network_players", { players: roomPlayers });

                for (const clientUuid in roomToJoin.players) {
                    const client = roomToJoin.players[clientUuid];
                    if (client !== socket) {
                        sendToSocket(client, "spawn_new_player", { player: newPlayer });
                    }
                }

                // O controlador existente é informado ao novo jogador.
                sendKillerOwnerToPlayer(roomToJoin, socket);

                if (getRoomPlayerCount(roomToJoin) >= 2 && !roomToJoin.lobbyStarted) {
                    roomToJoin.lobbyStarted = true;
                    console.log(`Sala ${roomCode} iniciou o lobby!`);
                    sendToRoom(roomToJoin, "start_game", {});
                } else if (roomToJoin.lobbyStarted) {
                    sendToSocket(socket, "start_game", {});
                }

                if (roomToJoin.missionId !== null) {
                    sendToSocket(socket, "mission_selected", {
                        mission_id: roomToJoin.missionId
                    });
                    sendReadyUpdate(roomToJoin);
                }

                break;
            }

            case "select_mission": {
                const room = rooms.get(socket.roomId);
                if (!room || !room.players[uuid]) return;
                if (!room.lobbyStarted || room.missionStarted) return;

                const missionId = content.mission_id;
                if (typeof missionId !== "string" || missionId.trim().length === 0) return;

                if (room.missionId === null) {
                    room.missionId = missionId;
                    room.readyPlayers.clear();
                    console.log(`Sala ${socket.roomId} selecionou ${missionId}`);
                } else if (room.missionId !== missionId) {
                    sendToSocket(socket, "error", {
                        msg: "Outro jogador já selecionou uma missão diferente."
                    });
                    return;
                }

                sendToRoom(room, "mission_selected", { mission_id: room.missionId });
                sendReadyUpdate(room);
                break;
            }

            case "player_ready": {
                const room = rooms.get(socket.roomId);
                if (!room || !room.players[uuid]) return;
                if (room.missionStarted || room.missionId === null) return;

                room.readyPlayers.add(uuid);
                console.log(`${uuid} está pronto (${getReadyCount(room)}/${getRoomPlayerCount(room)})`);
                sendReadyUpdate(room);
                tryStartMission(room, socket.roomId);
                break;
            }

            case "position": {
                const room = rooms.get(socket.roomId);
                if (!room || !room.players[uuid]) return;

                const { x, y, z, r_y, moving } = content;
                if (![x, y, z, r_y].every(isFiniteNumber)) return;

                playerlist.update(uuid, x, y, z, r_y);

                sendToRoom(room, "update_position", {
                    uuid,
                    x,
                    y,
                    z,
                    r_y,
                    moving: moving === true
                }, socket);
                break;
            }

            // Apenas o controlador eleito pode publicar o estado do Killer.
            case "killer_state": {
                const room = rooms.get(socket.roomId);
                if (!room || !room.players[uuid]) return;
                if (room.killerOwner !== uuid) return;

                const { x, y, z, r_y, moving } = content;
                if (![x, y, z, r_y].every(isFiniteNumber)) return;

                room.killerState = {
                    x,
                    y,
                    z,
                    r_y,
                    moving: moving === true
                };

                sendToRoom(room, "killer_state", room.killerState, socket);
                break;
            }

            case "chat": {
                const room = rooms.get(socket.roomId);
                if (!room || !room.players[uuid]) return;

                sendToRoom(room, "new_chat_message", {
                    uuid,
                    msg: String(content.msg || "")
                });
                break;
            }
        }
    });

    socket.on("close", () => {
        console.log(`Cliente desconectado: ${uuid}`);
        playerlist.remove(uuid);

        const roomCode = socket.roomId;
        const room = rooms.get(roomCode);
        if (!room) return;

        delete room.players[uuid];
        room.readyPlayers.delete(uuid);

        sendToRoom(room, "player_disconnected", { uuid });

        // Se o controlador sair, elege o primeiro jogador que ainda estiver na sala.
        if (room.killerOwner === uuid) {
            const remainingPlayers = Object.keys(room.players);

            if (remainingPlayers.length > 0) {
                room.killerState = null;
                setKillerOwner(room, roomCode, remainingPlayers[0]);
            } else {
                room.killerOwner = null;
                room.killerState = null;
            }
        }

        if (getRoomPlayerCount(room) === 0) {
            rooms.delete(roomCode);
            console.log(`Sala ${roomCode} vazia e removida.`);
            return;
        }

        if (room.missionId !== null && !room.missionStarted) {
            sendReadyUpdate(room);
            tryStartMission(room, roomCode);
        }
    });
});

wss.on("error", (error) => {
    console.error("Erro no WebSocket:", error);
});

server.on("error", (error) => {
    console.error("Erro no servidor:", error);
});

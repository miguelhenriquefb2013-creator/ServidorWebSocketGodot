
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
        socket.send(JSON.stringify({
            cmd: command,
            content
        }));
    }
}

function sendToRoom(room, command, content = {}) {
    for (const client of Object.values(room.players)) {
        sendToSocket(client, command, content);
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
            y: 300
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
        this.players = this.players.filter(
            player => player.uuid !== uuid
        );
    },

    getByRoom(roomCode) {
        return this.players.filter(
            player => player.room === roomCode
        );
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

    if (total === 0) return;

    if (ready !== total) return;

    room.missionStarted = true;

    console.log(
        `Iniciando missão ${room.missionId} na sala ${roomCode}`
    );

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

    sendToSocket(socket, "joined_server", {
        uuid
    });

    socket.on("message", (message) => {

        let data;

        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Erro ao interpretar mensagem:", err);
            return;
        }

        if (!data || typeof data.cmd !== "string") {
            return;
        }

        const content = data.content || {};

        switch (data.cmd) {

            // ========================
            // CRIAR SALA
            // ========================

            case "create_room": {

                if (socket.roomId) {
                    sendToSocket(socket, "error", {
                        msg: "Você já está em uma sala."
                    });
                    return;
                }

                let newRoomId;

                do {
                    newRoomId = generateRoomCode();
                } while (rooms.has(newRoomId));

                socket.roomId = newRoomId;

                const room = {
    players: {},
    hostUuid: uuid,
    killerState: null,
    missionId: null,
    readyPlayers: new Set(),
    missionStarted: false,
    lobbyStarted: false
};

                rooms.set(newRoomId, room);

                room.players[uuid] = socket;

                const newPlayer = playerlist.add(
                    uuid,
                    newRoomId
                );

                console.log(`Sala ${newRoomId} criada por ${uuid}`);

                sendToSocket(socket, "room_created", {
                    code: newRoomId,
                    host_uuid: room.hostUuid
                });

                sendToSocket(socket, "spawn_local_player", {
                    player: newPlayer
                });

                break;
            }

            // ========================
            // ENTRAR NA SALA
            // ========================

            case "join_room": {

                if (socket.roomId) {
                    sendToSocket(socket, "error", {
                        msg: "Você já está em uma sala."
                    });
                    return;
                }

                const roomCode = String(
                    content.code || ""
                ).toUpperCase();

                const roomToJoin = rooms.get(roomCode);

                if (!roomToJoin) {
                    sendToSocket(socket, "error", {
                        msg: "Sala não encontrada."
                    });
                    return;
                }

                if (roomToJoin.missionStarted) {
                    sendToSocket(socket, "error", {
                        msg: "A missão já começou."
                    });
                    return;
                }

                socket.roomId = roomCode;

                roomToJoin.players[uuid] = socket;

                const newPlayer = playerlist.add(
                    uuid,
                    roomCode
                );

                console.log(
                    `Jogador ${uuid} entrou na sala ${roomCode}`
                );

                sendToSocket(socket, "room_joined", {
    code: roomCode,
    host_uuid: roomToJoin.hostUuid
});

                sendToSocket(socket, "spawn_local_player", {
                    player: newPlayer
                });

                const roomPlayers = playerlist
                    .getByRoom(roomCode)
                    .filter(player => player.uuid !== uuid);

                sendToSocket(socket, "spawn_network_players", {
    players: roomPlayers
});

// ENVIAR POSIÇÃO DO KILLER

if (roomToJoin.killerState !== null) {
    sendToSocket(socket, "killer_update", {
        ...roomToJoin.killerState
    });
}

                // AVISAR OS OUTROS JOGADORES

                for (const clientUuid in roomToJoin.players) {

                    const client = roomToJoin.players[clientUuid];

                    if (client !== socket) {
                        sendToSocket(client, "spawn_new_player", {
                            player: newPlayer
                        });
                    }
                }

                // INICIAR O LOBBY UMA ÚNICA VEZ

                if (
                    getRoomPlayerCount(roomToJoin) >= 2 &&
                    !roomToJoin.lobbyStarted
                ) {

                    roomToJoin.lobbyStarted = true;

                    console.log(
                        `Sala ${roomCode} iniciou o lobby!`
                    );

                    sendToRoom(roomToJoin, "start_game", {});

                } else if (roomToJoin.lobbyStarted) {

                    // JOGADOR NOVO TAMBÉM VAI PARA O LOBBY

                    sendToSocket(socket, "start_game", {});
                }

                // SINCRONIZAR MISSÃO EM PREPARAÇÃO

                if (roomToJoin.missionId !== null) {

                    sendToSocket(socket, "mission_selected", {
                        mission_id: roomToJoin.missionId
                    });

                    sendReadyUpdate(roomToJoin);
                }

                break;
            }

            // ========================
            // SELECIONAR MISSÃO
            // ========================

            case "select_mission": {

                const room = rooms.get(socket.roomId);

                if (!room || !room.players[uuid]) return;

                if (!room.lobbyStarted || room.missionStarted) {
                    return;
                }

                const missionId = content.mission_id;

                if (
                    typeof missionId !== "string" ||
                    missionId.trim().length === 0
                ) {
                    return;
                }

                // PRIMEIRA SELEÇÃO

                if (room.missionId === null) {

                    room.missionId = missionId;
                    room.readyPlayers.clear();

                    console.log(
                        `Sala ${socket.roomId} selecionou ${missionId}`
                    );

                } else if (room.missionId !== missionId) {

                    sendToSocket(socket, "error", {
                        msg: "Outro jogador já selecionou uma missão diferente."
                    });

                    return;
                }

                // AVISAR TODOS

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

                if (!room || !room.players[uuid]) return;

                if (
                    room.missionStarted ||
                    room.missionId === null
                ) {
                    return;
                }

                room.readyPlayers.add(uuid);

                console.log(
                    `${uuid} está pronto (${getReadyCount(room)}/${getRoomPlayerCount(room)})`
                );

                sendReadyUpdate(room);

                // VERIFICAR SE TODOS ESTÃO PRONTOS

                tryStartMission(room, socket.roomId);

                break;
            }

            // ========================
            // POSIÇÃO
            // ========================

            case "position": {

                const room = rooms.get(socket.roomId);

                if (!room || !room.players[uuid]) return;

                playerlist.update(
                    uuid,
                    content.x,
                    content.y,
                    content.z,
                    content.r_y
                );

                for (const clientUuid in room.players) {

                    const client = room.players[clientUuid];

                    if (client !== socket) {

                        sendToSocket(client, "update_position", {
                            uuid,
                            x: content.x,
                            y: content.y,
                            z: content.z,
                            r_y: content.r_y,
                            moving: content.moving
                        });
                    }
                }

                break;
            }
// ========================
// SINCRONIZAÇÃO DO KILLER
// ========================

case "killer_position": {

    const room = rooms.get(socket.roomId);

    if (!room || !room.players[uuid]) return;

    // Somente o host pode controlar o Killer.
    if (room.hostUuid !== uuid) return;

    const { x, y, z, r_y } = content;

    if (![x, y, z, r_y].every(Number.isFinite)) {
        return;
    }

    room.killerState = {
        x, y, z, r_y
    };

    // Enviar para todos os jogadores da sala.
    sendToRoom(room, "killer_update", room.killerState);

    break;
}
            // ========================
            // CHAT
            // ========================

            case "chat": {

                const room = rooms.get(socket.roomId);

                if (!room || !room.players[uuid]) return;

                sendToRoom(room, "new_chat_message", {
                    uuid,
                    msg: content.msg
                });

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

        const roomCode = socket.roomId;
        const room = rooms.get(roomCode);

        if (!room) return;

        delete room.players[uuid];
        // TRANSFERIR HOST

if (room.hostUuid === uuid) {

    room.hostUuid = Object.keys(room.players)[0] || null;

    if (room.hostUuid) {
        sendToRoom(room, "host_changed", {
            host_uuid: room.hostUuid
        });

        console.log(
            `Novo host da sala ${roomCode}: ${room.hostUuid}`
        );
    }
}

        room.readyPlayers.delete(uuid);

        // AVISAR OS OUTROS JOGADORES

        sendToRoom(room, "player_disconnected", {
            uuid
        });

        // REMOVER SALA VAZIA

        if (getRoomPlayerCount(room) === 0) {

            rooms.delete(roomCode);

            console.log(
                `Sala ${roomCode} vazia e removida.`
            );

            return;
        }

        // ATUALIZAR PREPARAÇÃO

        if (room.missionId !== null && !room.missionStarted) {

            sendReadyUpdate(room);

            // SE TODOS OS RESTANTES JÁ ESTIVEREM PRONTOS,
            // INICIAR A MISSÃO.

            tryStartMission(room, roomCode);
        }
    });
});

// ========================
// ERROS DO SERVIDOR
// ========================

wss.on("error", (error) => {
    console.error("Erro no WebSocket:", error);
});

server.on("error", (error) => {
    console.error("Erro no servidor:", error);
});
       

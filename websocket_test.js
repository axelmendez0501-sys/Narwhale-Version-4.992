const WebSocket = require('ws');

// ==================== CONFIGURACIÓN ====================
const CONFIG = {
  port: 443,
  tickRate: 60,
  worldWidth: 6400,
  worldHeight: 6400,
  maxPlayersPerRoom: 50,
  
  // Seguridad
  maxInputRate: 120, // inputs por segundo
  maxVelocity: 500,
  maxDashCooldown: 1.0,
  teleportThreshold: 1000, // detección de teleport
  
  // Física
  friction: 0.95,
  acceleration: 200,
  dashPower: 300,
  collisionDamage: 100,
};

// ==================== OPCODES ====================
const OPCODES = {
  // Cliente → Servidor
  JOIN: 16,
  LEAVE: 17,
  START: 18,
  GET_LOBBIES: 19,
  UPDATE_TARGET: 32,
  SPLIT_UP: 33,
  RIP: 34,
  RETREAT: 35,
  PLAYER_UPDATE: 36,
  PING: 37,
  INPUT: 38,

  // Servidor → Cliente
  SET_ELEMENTS: 48,
  PLAYER_INFO: 49,
  LEADER_BOARD: 50,
  TEAM_INFO: 51,
  TRANSIENT_ELEMENT: 52
};

// ==================== TIPOS DE ELEMENTOS ====================
const ELEMENT_TYPES = {
  FISH: 0,
  BALL: 1,
  ATTACHABLE: 2,
  CHARACTER: 3,
  BOMB: 4,
  OCCUPIABLE: 5,
  FOOD: 6
};

// ==================== UTILIDADES MATEMÁTICAS ====================
class Vec2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  normalize() {
    const len = this.length();
    if (len > 0) {
      this.x /= len;
      this.y /= len;
    }
    return this;
  }

  clone() {
    return new Vec2(this.x, this.y);
  }

  distance(other) {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

// ==================== SISTEMA DE VALIDACIÓN ====================
class InputValidator {
  constructor() {
    this.playerInputs = new Map(); // playerId -> {count, lastReset}
  }

  validateInputRate(playerId) {
    const now = Date.now();
    if (!this.playerInputs.has(playerId)) {
      this.playerInputs.set(playerId, { count: 0, lastReset: now });
    }

    const data = this.playerInputs.get(playerId);
    
    // Reset contador cada segundo
    if (now - data.lastReset > 1000) {
      data.count = 0;
      data.lastReset = now;
    }

    data.count++;
    
    // Rate limiting
    if (data.count > CONFIG.maxInputRate) {
      console.warn(`⚠️ Rate limit excedido: Player ${playerId}`);
      return false;
    }

    return true;
  }

  validatePosition(oldPos, newPos, deltaTime) {
    const maxDistance = CONFIG.maxVelocity * deltaTime;
    const actualDistance = oldPos.distance(newPos);
    
    if (actualDistance > maxDistance * 2) { // 2x para tolerancia de lag
      console.warn(`⚠️ Teleport detectado: ${actualDistance.toFixed(2)} > ${maxDistance.toFixed(2)}`);
      return false;
    }
    
    return true;
  }

  validateDash(player) {
    const now = Date.now();
    
    if (player.curDash <= 0) {
      console.warn(`⚠️ Dash sin carga: Player ${player.id}`);
      return false;
    }

    if (player.lastDashTime && (now - player.lastDashTime) < 100) {
      console.warn(`⚠️ Dash spam: Player ${player.id}`);
      return false;
    }

    return true;
  }
}

// ==================== PARTE DEL NARVAL ====================
class NarwhalePart {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.rot = 0;
    this.vt = 0;
    this.oriRot = 0;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.rot += this.vt * dt;
  }

  dampVelocity(factor, dt) {
    this.vx *= Math.pow(factor, dt * 60);
    this.vy *= Math.pow(factor, dt * 60);
  }
}

// ==================== JUGADOR ====================
class Player {
  constructor(id, socket, name = 'Narwhal') {
    this.id = id;
    this.socket = socket;
    this.name = name.substring(0, 16);
    this.uid = id;

    // Visual
    this.color = this.randomColor();
    this.team = Math.random() > 0.5 ? 1 : -1;
    this.size = 36;
    this.alpha = 1.0;
    this.level = 1;
    this.score = 0;
    this.kills = 0;
    this.deaths = 0;

    // Física (AUTORIDAD DEL SERVIDOR)
    this.pos = new Vec2(CONFIG.worldWidth / 2, CONFIG.worldHeight / 2);
    this.vel = new Vec2(0, 0);
    this.angle = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.maxSpeed = 150;

    // Partes del cuerpo
    this.parts = [];
    this.breakPoint = 11;
    this.initializeParts();

    // Habilidades
    this.maxDash = 5;
    this.curDash = 5;
    this.overDash = 0;
    this.dashRegenRate = 0.6; // por segundo
    this.tuskRatio = 0.5;
    this.decoration = 0;
    this.invincibleDur = 0;
    this.skincode = Math.floor(Math.random() * 18);

    // Estado
    this.isAlive = true;
    this.isSpawned = false;
    this.respawnTime = 0;
    this.currentRoom = null;

    // Input del cliente (validado)
    this.targetX = 0.001;
    this.targetY = 0;
    this.inputFlags = 0;

    // Anti-cheat
    this.lastPosition = this.pos.clone();
    this.lastDashTime = 0;
    this.inputSequence = 0;
    this.lastInputTime = Date.now();
  }

  initializeParts() {
    for (let i = 0; i < 11; i++) {
      const part = new NarwhalePart();
      part.x = this.pos.x - i * 20;
      part.y = this.pos.y;
      part.rot = this.angle;
      this.parts.push(part);
    }
  }

  randomColor() {
    const h = Math.random();
    const s = 0.9;
    const l = 0.635;
    return this.hslToRgb(h, s, l);
  }

  hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
  }

  spawn(room) {
    this.isAlive = true;
    this.isSpawned = true;

    this.pos.x = Math.random() * (room.config.options.width - 400) + 200;
    this.pos.y = Math.random() * (room.config.options.height - 400) + 200;
    this.vel.x = 0;
    this.vel.y = 0;
    this.invincibleDur = 2.0;
    this.curDash = this.maxDash;
    this.size = 36;
    this.level = 1;

    for (let i = 0; i < this.parts.length; i++) {
      this.parts[i].x = this.pos.x - i * 20;
      this.parts[i].y = this.pos.y;
      this.parts[i].vx = 0;
      this.parts[i].vy = 0;
      this.parts[i].rot = this.angle;
    }

    this.lastPosition = this.pos.clone();
  }

  // ==================== MOTOR DE FÍSICA AUTORITATIVO ====================
  update(dt, validator) {
    if (!this.isAlive) {
      if (Date.now() > this.respawnTime) {
        const room = global.gameServer.rooms.get(this.currentRoom);
        if (room) this.spawn(room);
      }
      return;
    }

    this.invincibleDur = Math.max(0, this.invincibleDur - dt);

    // Regenerar dash (SERVIDOR controla esto)
    if (this.curDash < this.maxDash) {
      this.overDash += dt * this.dashRegenRate;
      if (this.overDash >= 1.0) {
        this.curDash = Math.min(this.maxDash, this.curDash + 1);
        this.overDash = 0;
      }
    }

    // Procesar movimiento basado en input validado
    this.processMovement(dt);
    this.updateParts(dt);
    this.clampToWorld();
    this.updateSize();

    // Actualizar posición anterior para anti-cheat
    this.lastPosition = this.pos.clone();
  }

  processMovement(dt) {
    const dx = this.targetX - this.pos.x;
    const dy = this.targetY - this.pos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 10) {
      const normalX = dx / distance;
      const normalY = dy / distance;

      // Aplicar aceleración
      this.vel.x += normalX * CONFIG.acceleration * dt;
      this.vel.y += normalY * CONFIG.acceleration * dt;

      // Limitar velocidad máxima
      const currentSpeed = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);
      if (currentSpeed > this.maxSpeed) {
        this.vel.x = (this.vel.x / currentSpeed) * this.maxSpeed;
        this.vel.y = (this.vel.y / currentSpeed) * this.maxSpeed;
      }

      this.angle = Math.atan2(dy, dx);
    }

    // Fricción
    this.vel.x *= CONFIG.friction;
    this.vel.y *= CONFIG.friction;

    // Actualizar posición
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    this.speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);
  }

  updateParts(dt) {
    this.parts[0].x = this.pos.x;
    this.parts[0].y = this.pos.y;
    this.parts[0].rot = this.angle;
    this.parts[0].vx = this.vel.x;
    this.parts[0].vy = this.vel.y;

    for (let i = 1; i < this.parts.length; i++) {
      const part = this.parts[i];
      const prevPart = this.parts[i - 1];

      if (i !== this.breakPoint) {
        const segmentLength = 25 + this.size * 0.2;
        const targetX = prevPart.x - Math.cos(prevPart.rot) * segmentLength;
        const targetY = prevPart.y - Math.sin(prevPart.rot) * segmentLength;

        const followSpeed = 0.4;
        part.x += (targetX - part.x) * followSpeed;
        part.y += (targetY - part.y) * followSpeed;

        const dx = prevPart.x - part.x;
        const dy = prevPart.y - part.y;
        part.rot = Math.atan2(dy, dx);
        part.oriRot = part.rot;
      } else {
        part.update(dt);
        part.vx *= 0.98;
        part.vy *= 0.98;
        part.vt *= 0.95;
      }
    }
  }

  clampToWorld() {
    const room = global.gameServer.rooms.get(this.currentRoom);
    if (!room) return;

    const margin = 100;
    this.pos.x = Math.max(margin, Math.min(room.config.options.width - margin, this.pos.x));
    this.pos.y = Math.max(margin, Math.min(room.config.options.height - margin, this.pos.y));
  }

  updateSize() {
    this.level = Math.floor(this.score / 100) + 1;
    this.size = 36 + (this.level - 1) * 3;
    this.maxSpeed = Math.max(80, 150 - (this.level - 1) * 5);
  }

  // ==================== MANEJO DE INPUTS (VALIDADOS) ====================
  setTarget(x, y, validator) {
    // Validación de límites
    const room = global.gameServer.rooms.get(this.currentRoom);
    if (!room) return;

    this.targetX = Math.max(0, Math.min(room.config.options.width, x));
    this.targetY = Math.max(0, Math.min(room.config.options.height, y));
  }

  useDash(validator) {
    if (!validator.validateDash(this)) {
      return false;
    }

    if (this.curDash > 0) {
      this.curDash--;
      this.lastDashTime = Date.now();
      
      const dashPower = CONFIG.dashPower;
      this.vel.x += Math.cos(this.angle) * dashPower;
      this.vel.y += Math.sin(this.angle) * dashPower;
      
      return true;
    }
    return false;
  }

  takeDamage(amount, attacker = null) {
    if (this.invincibleDur > 0) return false;

    if (attacker && attacker !== this) {
      attacker.kills++;
      attacker.score += 100 + this.level * 20;
    }

    this.die();
    return true;
  }

  die() {
    this.isAlive = false;
    this.isSpawned = false;
    this.deaths++;
    this.respawnTime = Date.now() + 3000;

    const ripBuffer = Buffer.from([OPCODES.RIP]);
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(ripBuffer);
    }
  }
}

// ==================== COMIDA ====================
class Food {
  constructor(x, y, value = 1) {
    this.id = Date.now() + Math.random() * 1000;
    this.x = x;
    this.y = y;
    this.value = value;
    this.size = value > 1 ? 8 : 4;
    this.color = value > 1 ? 0xff6b6b : 0x4ecdc4;
  }
}

// ==================== SALA DE JUEGO ====================
class GameRoom {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.players = new Map();
    this.foods = [];
    this.validator = new InputValidator();

    this.generateFood(300);
  }

  generateFood(count) {
    for (let i = 0; i < count; i++) {
      const x = Math.random() * (this.config.options.width - 200) + 100;
      const y = Math.random() * (this.config.options.height - 200) + 100;
      const value = Math.random() < 0.1 ? 3 : 1;
      this.foods.push(new Food(x, y, value));
    }
  }

  addPlayer(player) {
    this.players.set(player.id, player);
    player.currentRoom = this.id;
    this.config.playerCount = this.players.size;
    player.spawn(this);
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      this.players.delete(playerId);
      this.config.playerCount = this.players.size;
    }
  }

  // ==================== LOOP DE SIMULACIÓN ====================
  update(dt) {
    // Actualizar todos los jugadores (física autoritativa)
    for (const player of this.players.values()) {
      player.update(dt, this.validator);
    }

    // Detectar colisiones
    this.checkCollisions();

    // Regenerar comida
    if (this.foods.length < 250) {
      this.generateFood(10);
    }
  }

  checkCollisions() {
    const alivePlayers = Array.from(this.players.values()).filter(p => p.isAlive);

    // Colisiones jugador-jugador
    for (let i = 0; i < alivePlayers.length; i++) {
      for (let j = i + 1; j < alivePlayers.length; j++) {
        const p1 = alivePlayers[i];
        const p2 = alivePlayers[j];

        const distance = p1.pos.distance(p2.pos);
        const collisionDistance = (p1.size + p2.size) * 0.6;

        if (distance < collisionDistance) {
          const sizeDiff = p1.size - p2.size;
          const threshold = 10;

          if (sizeDiff > threshold) {
            p2.takeDamage(CONFIG.collisionDamage, p1);
          } else if (sizeDiff < -threshold) {
            p1.takeDamage(CONFIG.collisionDamage, p2);
          }
        }
      }
    }

    // Colisiones con comida
    for (const player of alivePlayers) {
      for (let i = this.foods.length - 1; i >= 0; i--) {
        const food = this.foods[i];
        const distance = Math.sqrt(
          (player.pos.x - food.x) ** 2 + 
          (player.pos.y - food.y) ** 2
        );

        if (distance < player.size / 2 + food.size) {
          player.score += food.value * 10;
          this.foods.splice(i, 1);

          if (Math.random() < 0.7) {
            const x = Math.random() * (this.config.options.width - 200) + 100;
            const y = Math.random() * (this.config.options.height - 200) + 100;
            const value = Math.random() < 0.1 ? 3 : 1;
            this.foods.push(new Food(x, y, value));
          }
        }
      }
    }
  }
}

// ==================== CODIFICADOR DE PAQUETES ====================
class PacketEncoder {
  static encodeUintAngle(angle) {
    return Math.floor(((angle / Math.PI + 1) / 2) * 255);
  }

  static encodeSetElements(room) {
    const players = Array.from(room.players.values()).filter(p => p.isAlive && p.isSpawned);
    const foods = room.foods.slice(0, 100);

    let bufferSize = 50;
    players.forEach(p => {
      bufferSize += 60 + Buffer.byteLength(p.name, 'utf8') + (p.parts.length * 5);
    });
    bufferSize += foods.length * 20;

    const buffer = Buffer.alloc(bufferSize);
    let offset = 0;

    buffer.writeUInt8(OPCODES.SET_ELEMENTS, offset++);
    buffer.writeUInt16LE(Date.now() & 0xFFFF, offset); offset += 2;
    buffer.writeUInt8(0, offset++); // worldFlags

    // Codificar jugadores
    for (const player of players) {
      offset = this.encodeFishElement(buffer, offset, player);
    }

    // Codificar comida
    for (const food of foods) {
      offset = this.encodeFoodElement(buffer, offset, food);
    }

    return buffer.slice(0, offset);
  }

  static encodeFishElement(buffer, offset, player) {
    buffer.writeUInt8(ELEMENT_TYPES.FISH, offset++);

    const playerId = typeof player.id === 'string' ? 
      parseInt(player.id.slice(-8), 16) || Math.abs(player.id.hashCode?.() || 0) :
      Math.abs(player.id);
    buffer.writeUInt32LE(playerId & 0xFFFFFFFF, offset); offset += 4;

    buffer.writeUInt8((player.color >> 16) & 0xFF, offset++);
    buffer.writeUInt8((player.color >> 8) & 0xFF, offset++);
    buffer.writeUInt8(player.color & 0xFF, offset++);

    const nameBytes = Buffer.from(player.name, 'utf8');
    const nameLength = Math.min(nameBytes.length, 20);
    nameBytes.copy(buffer, offset, 0, nameLength);
    offset += nameLength;
    buffer.writeUInt8(0, offset++);

    buffer.writeUInt8(player.team | (player.level << 3), offset++);
    buffer.writeUInt8(Math.floor(player.alpha * 255), offset++);
    buffer.writeUInt8(player.maxDash | (player.curDash << 4), offset++);
    buffer.writeUInt8(Math.floor(player.overDash * 255), offset++);
    buffer.writeUInt8(Math.floor(player.tuskRatio * 127), offset++);
    buffer.writeUInt8(player.decoration, offset++);

    buffer.writeFloatLE(player.parts[0].x, offset); offset += 4;
    buffer.writeFloatLE(player.parts[0].y, offset); offset += 4;

    const speed = Math.sqrt(player.parts[0].vx * player.parts[0].vx + player.parts[0].vy * player.parts[0].vy);
    const angle = Math.atan2(player.parts[0].vy, player.parts[0].vx);

    buffer.writeUInt16LE(Math.min(Math.floor(speed), 65535), offset); offset += 2;
    buffer.writeUInt8(this.encodeUintAngle(angle), offset++);
    buffer.writeUInt8(this.encodeUintAngle(player.parts[0].rot), offset++);

    buffer.writeUInt8(player.skincode, offset++);
    buffer.writeUInt8(Math.floor(player.invincibleDur * 255), offset++);

    buffer.writeUInt8(player.parts.length - 1, offset++);

    for (let i = 1; i < player.parts.length; i++) {
      const part = player.parts[i];
      if (i !== player.breakPoint) {
        buffer.writeUInt8(this.encodeUintAngle(part.rot), offset++);
      } else {
        buffer.writeFloatLE(part.x, offset); offset += 4;
        buffer.writeFloatLE(part.y, offset); offset += 4;
        buffer.writeFloatLE(part.vx, offset); offset += 4;
        buffer.writeFloatLE(part.vy, offset); offset += 4;
      }
    }

    return offset;
  }

  static encodeFoodElement(buffer, offset, food) {
    buffer.writeUInt8(ELEMENT_TYPES.FOOD, offset++);
    buffer.writeUInt32LE(food.id, offset); offset += 4;
    buffer.writeFloatLE(food.x, offset); offset += 4;
    buffer.writeFloatLE(food.y, offset); offset += 4;
    buffer.writeUInt8(food.value, offset++);
    buffer.writeUInt8(food.size, offset++);

    buffer.writeUInt8((food.color >> 16) & 0xFF, offset++);
    buffer.writeUInt8((food.color >> 8) & 0xFF, offset++);
    buffer.writeUInt8(food.color & 0xFF, offset++);

    return offset;
  }

  static encodeLeaderBoard(players) {
    const topPlayers = Array.from(players.values())
      .filter(p => p.isAlive)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    let bufferSize = 3 + topPlayers.length * 30;
    const buffer = Buffer.alloc(bufferSize);
    let offset = 0;

    buffer.writeUInt8(OPCODES.LEADER_BOARD, offset++);
    buffer.writeUInt8(topPlayers.length, offset++);

    for (const player of topPlayers) {
      buffer.writeUInt8(player.level, offset++);

      const nameBytes = Buffer.from(player.name, 'utf8');
      const nameLength = Math.min(nameBytes.length, 25);
      nameBytes.copy(buffer, offset, 0, nameLength);
      offset += nameLength;
      buffer.writeUInt8(0, offset++);
    }

    buffer.writeUInt8(topPlayers.length, offset++);
    for (const player of topPlayers) {
      buffer.writeUInt8(Math.min(player.level, 255), offset++);
    }

    return buffer.slice(0, offset);
  }
}

// ==================== CONFIGURACIÓN DE SALAS ====================
const ROOMS_CONFIG = [
    {
        options: {
          width: 6400,
          height: 6400,
          cellWidth: 1280,
          hasIndicator: false,
          isPriority: true,
          fieldType: 0,
          desirablePlayerNum: 25,
          hasSlowFactor: false
        },
        name: "Large 1",
        id: 0,
        playerCount: 0
      },
      {
        options: {
          width: 6400,
          height: 6400,
          cellWidth: 1280,
          hasIndicator: false,
          isPriority: true,
          fieldType: 0,
          desirablePlayerNum: 25,
          hasSlowFactor: false
        },
        name: "Large 2",
        id: 1,
        playerCount: 0
      },
      {
        options: {
          width: 6400,
          height: 6400,
          cellWidth: 1280,
          hasIndicator: false,
          isPriority: false,
          fieldType: 0,
          desirablePlayerNum: 9,
          hasSlowFactor: false
        },
        name: "Sparse",
        id: 2,
        playerCount: 0
      },
      {
        options: {
          width: 3840,
          height: 3840,
          cellWidth: 1280,
          hasIndicator: false,
          isPriority: false,
          fieldType: 0,
          desirablePlayerNum: 9,
          hasSlowFactor: false
        },
        name: "Small 1",
        id: 3,
        playerCount: 0
      },
      { 
        options: {
          width: 3840,
          height: 3840,
          cellWidth: 1280,
          hasIndicator: false,
          isPriority: true,
          fieldType: 0,
          desirablePlayerNum: 6,
          hasSlowFactor: false
        },
        name: "Small 2",
        id: 4,
        playerCount: 0
      },
      {
        options: {
          width: 6400,
          height: 3840,
          cellWidth: 1280,
          hasIndicator: true,
          isPriority: false,
          fieldType: 1,
          desirablePlayerNum: 25,
          hasSlowFactor: true
        },
        name: "Narwhale Ball!",
        id: 5,
        playerCount: 0
      },
      {
        options: {
          width: 6400,
          height: 5120,
          cellWidth: 1280,
          hasIndicator: true,
          isPriority: false,
          fieldType: 3,
          desirablePlayerNum: 25,
          hasSlowFactor: true
        },
        name: "Narwhale Egg Hunt!",
        id: 7,
        playerCount: 0
      },
      {
        options: {
          width: 6400,
          height: 6400,
          cellWidth: 1280,
          hasIndicator: true,
          isPriority: false,
          fieldType: 4,
          desirablePlayerNum: 25,
          hasSlowFactor: true
        },
        name: "Team Deathmatch",
        id: 8,
        playerCount: 0
      }
    ];

// ==================== SERVIDOR PRINCIPAL ====================
class NarwhaleGameServer {
  constructor() {
    this.wss = null;
    this.players = new Map();
    this.rooms = new Map();
    this.lastTick = Date.now();
    this.validator = new InputValidator();

    this.initializeRooms();
    global.gameServer = this;
  }

  initializeRooms() {
    for (const config of ROOMS_CONFIG) {
      const room = new GameRoom(config);
      this.rooms.set(config.id, room);
    }
  }

  start() {
    this.wss = new WebSocket.Server({ port: CONFIG.port, host: '0.0.0.0' });

    this.wss.on('connection', (socket, request) => {
      this.handleNewConnection(socket, request);
    });

    this.startGameLoop();

    console.log(`🚀 Servidor iniciado en puerto ${CONFIG.port}`);
    console.log(`🔄 Game loop iniciado a ${CONFIG.tickRate} FPS`);
  }

  handleNewConnection(socket, request) {
    const playerId = Date.now() + Math.floor(Math.random() * 1000);

    socket.playerId = playerId;
    socket.currentRoom = null;

    socket.on('message', (data) => {
      this.handleMessage(socket, data);
    });

    socket.on('close', () => {
      this.handleDisconnection(socket);
    });
  }

  handleMessage(socket, data) {
    if (!data || data.length === 0) return;

    const opcode = data[0];

    try {
      switch (opcode) {
        case OPCODES.GET_LOBBIES:
          this.handleGetLobbies(socket);
          break;

        case OPCODES.JOIN:
          this.handleJoin(socket, data);
          break;

        case OPCODES.START:
          this.handleStart(socket, data);
          break;

        case OPCODES.UPDATE_TARGET:
          this.handleUpdateTarget(socket, data);
          break;

        case OPCODES.INPUT:
          this.handleInput(socket, data);
          break;

        case OPCODES.PING:
          this.handlePing(socket, data);
          break;

        case OPCODES.LEAVE:
          this.handleLeave(socket);
          break;
      }
    } catch (error) {
      console.error('Error procesando mensaje:', error);
    }
  }

  handleGetLobbies(socket) {
    const roomsData = ROOMS_CONFIG.map(config => {
      const room = this.rooms.get(config.id);
      return {
        ...config,
        playerCount: room ? room.players.size : 0
      };
    });

    const jsonData = JSON.stringify(roomsData);
    const response = Buffer.concat([
      Buffer.from([OPCODES.GET_LOBBIES]),
      Buffer.from(jsonData, 'utf8'),
      Buffer.from([0x00])
    ]);

    socket.send(response);
  }

  handleJoin(socket, data) {
    if (data.length < 5) return;

    const roomId = data.readUInt32LE(1);
    const room = this.rooms.get(roomId);

    if (room) {
      socket.currentRoom = roomId;

      const response = Buffer.alloc(5);
      response.writeUInt8(OPCODES.JOIN, 0);
      response.writeUInt32LE(roomId, 1);
      socket.send(response);
    }
  }

  handleStart(socket, data) {
    if (data.length < 9) return;

    let offset = 1;
    const skincode = data.readUInt8(offset++);
    const colorcode = data.readUInt32LE(offset); offset += 4;

    let playerName = 'Narwhal';
    if (data.length > 9) {
      const nameBytes = data.slice(9);
      const nameEnd = nameBytes.indexOf(0);
      playerName = nameEnd >= 0 ? 
        nameBytes.slice(0, nameEnd).toString('utf8') : 
        nameBytes.toString('utf8');
    }

    const player = new Player(socket.playerId, socket, playerName);
    player.skincode = skincode;
    player.color = colorcode;

    this.players.set(socket.playerId, player);

    if (socket.currentRoom !== null) {
      const room = this.rooms.get(socket.currentRoom);
      if (room) {
        room.addPlayer(player);
      }
    }

    const response = Buffer.alloc(3);
    response.writeUInt8(OPCODES.START, 0);
    response.writeUInt16LE(socket.playerId & 0xFFFF, 1);
    socket.send(response);
  }

  handleUpdateTarget(socket, data) {
    if (data.length >= 9) {
      // Validar rate limiting
      if (!this.validator.validateInputRate(socket.playerId)) {
        return; // Ignorar si excede rate limit
      }

      const x = data.readFloatLE(1);
      const y = data.readFloatLE(5);

      const player = this.players.get(socket.playerId);
      if (player) {
        player.setTarget(x, y, this.validator);
      }
    }
  }

  handleInput(socket, data) {
    if (data.length >= 2) {
      // Validar rate limiting
      if (!this.validator.validateInputRate(socket.playerId)) {
        return;
      }

      const control = data.readUInt8(1);
      const player = this.players.get(socket.playerId);

      if (player && (control & 0x10)) {
        player.useDash(this.validator);
      }
    }
  }

  handlePing(socket, data) {
    if (data.length >= 5) {
      const timestamp = data.readFloatLE(1);
      const response = Buffer.alloc(5);
      response.writeUInt8(OPCODES.PING, 0);
      response.writeFloatLE(timestamp, 1);
      socket.send(response);
    }
  }

  handleLeave(socket) {
    this.handleDisconnection(socket);
  }

  handleDisconnection(socket) {
    const player = this.players.get(socket.playerId);
    if (player && player.currentRoom !== null) {
      const room = this.rooms.get(player.currentRoom);
      if (room) {
        room.removePlayer(socket.playerId);
      }
    }
    this.players.delete(socket.playerId);
  }

  // ==================== GAME LOOP ====================
  startGameLoop() {
    const targetFrameTime = 1000 / CONFIG.tickRate;

    setInterval(() => {
      const now = Date.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;

      // Actualizar todas las salas (física autoritativa)
      for (const room of this.rooms.values()) {
        room.update(dt);
      }

      // Enviar updates a los clientes
      this.sendUpdates();

    }, targetFrameTime);
  }

  sendUpdates() {
    for (const room of this.rooms.values()) {
      if (room.players.size > 0) {
        const gameStateBuffer = PacketEncoder.encodeSetElements(room);

        for (const player of room.players.values()) {
          if (player.socket.readyState === WebSocket.OPEN) {
            player.socket.send(gameStateBuffer);
          }
        }
      }
    }

    // Enviar leaderboard cada 5 segundos
    if (Date.now() % 5000 < 20) {
      for (const room of this.rooms.values()) {
        if (room.players.size > 1) {
          const leaderboard = PacketEncoder.encodeLeaderBoard(room.players);
          for (const player of room.players.values()) {
            if (player.socket.readyState === WebSocket.OPEN) {
              player.socket.send(leaderboard);
            }
          }
        }
      }
    }
  }
}

// ==================== INICIAR SERVIDOR ====================
const server = new NarwhaleGameServer();
server.start();

console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║                                                                ║
║           🐋 SERVIDOR NARWHALE AUTORITATIVO 🌊                ║ 
╠════════════════════════════════════════════════════════════════╣
║ Puerto: ${CONFIG.port}                                         ║           ║
║ Tick Rate: ${CONFIG.tickRate} FPS                              ║               ║
║ Anti-Cheat: ACTIVADO                                          ║║
║ Física: Servidor Autoritativo                                 ║║
║ 🎮 Servidor listo para recibir conexiones                      ║ ║
╚════════════════════════════════════════════════════════════════╝
`);

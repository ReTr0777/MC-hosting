export enum GlobalRole {
  GLOBAL_ADMIN = 'GLOBAL_ADMIN',
  USER = 'USER',
}

export enum ServerRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  VIEWER = 'VIEWER',
}

export enum ServerStatus {
  OFFLINE = 'OFFLINE',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  INSTALLING = 'INSTALLING',
  ERROR = 'ERROR',
}

export enum ServerType {
  VANILLA = 'VANILLA',
  FABRIC = 'FABRIC',
  FORGE = 'FORGE',
  PAPER = 'PAPER',
  PURPUR = 'PURPUR',
  MODRINTH = 'MODRINTH',
  CURSEFORGE = 'CURSEFORGE',
}

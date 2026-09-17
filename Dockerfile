# ---------- Builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# generate prisma client to src/generated/prisma
RUN npx prisma generate

# build typescript -> dist
RUN npm run build


# ---------- Runtime ----------
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

# compiled app
COPY --from=builder /app/dist ./dist

# prisma schema (optional but useful)
COPY --from=builder /app/prisma ./prisma

EXPOSE 5000
CMD ["node", "dist/server.js"]

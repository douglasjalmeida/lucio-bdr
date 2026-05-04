FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY .claude/identidade-lucio.md ./.claude/identidade-lucio.md

ENV NODE_ENV=production
ENV TZ=America/Sao_Paulo
ENV PORT=8788

EXPOSE 8788

CMD ["node", "src/server.js"]

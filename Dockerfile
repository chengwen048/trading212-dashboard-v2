FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache python3 py3-pip

COPY package.json ./
COPY requirements.txt ./
COPY server.js ./
COPY tools ./tools
COPY public ./public

RUN python3 -m pip install --break-system-packages -r requirements.txt || true

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4312

EXPOSE 4312

CMD ["node", "server.js"]

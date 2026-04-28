FROM oven/bun:1-slim
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["bun", "server.ts"]

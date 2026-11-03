FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY index.js .
CMD ["node", "index.js"]

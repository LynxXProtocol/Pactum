FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
# `npm run build` (tsc) needs the `typescript` devDependency -- this is a single-stage build with
# no separate runtime stage to prune dev deps from afterward, so --only=production here just broke
# the very next step.
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000 9090

USER node

CMD ["npm", "start"]

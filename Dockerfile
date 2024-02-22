FROM node:21-slim
WORKDIR /usr/src/app
COPY ./package.json ./
RUN npm install --omit=dev
COPY ./index.js ./
COPY ./library/* ./library/
COPY ./commands/* ./commands/
CMD [ "node", "index.js" ]

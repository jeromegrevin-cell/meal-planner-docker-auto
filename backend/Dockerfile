FROM node:18

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001
# Command overriden by docker-compose for dev hot reload
CMD ["node", "src/index.js"]

FROM node:18

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
# Command overriden by docker-compose for dev hot reload
CMD ["npm", "run", "dev"]

import {createSocket } from "node:dgram";

const server = createSocket("udp4");

server.on("error", (err) => {
    console.error(`server error: \n${err.stack}`);
});

server.on("message", (msg, rinfo) => {
    console.log(`server got: ${msg} from ${rinfo.address}:${rinfo.port}`);
});

server.on("listening", () =>{
    const address = server.address();
    console.log(`server listening ${address.address}:${address.port}`);
});

server.bind(5000);
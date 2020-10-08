'use strict';

const Net = require('net');

const Globals = require('../globals/globals');
const Config = require('../globals/config');
const CacheMemory = require('./libs/cacheMemory');
const CommandParser = require('./libs/commandParser');
const ConsoleParser = require('./libs/consoleParser');

const server = new Net.Server();
const cache = new CacheMemory(Config.memsize, Config.dataMaxSize);
const commandParser = new CommandParser(null, Globals.OPERATIONS);
const consoleParser = new ConsoleParser();

//Loads the command line parameters into the global Config object.
Config.loadConfig( consoleParser.getParams(process.argv) );

cache.purgeExpired(Config.purgeKeys);

server.listen(Config.port, () => { console.log(`Memcached server is now running on port: ${Config.port}`) });
server.on('connection', handleConnection);

function handleConnection(socket){

  /* Context object, used to keep track of the overall flow state
   * across all the events in the server.
   */
  let context = {
    receivingData : false,
    line : {
      command: null,
      key: null,
      flags: 0,
      expTime: 0,
      bytes: 0,
      casUnique: 0,
      noreply : false,
    },
    data: null,
    bytesRead: 0,
    buffer: null,

    reset(){

    this.receivingData = false;
    this.line = {
      command: null,
      key: null,
      flags: 0,
      expTime: 0,
      bytes: 0,
      casUnique: 0,
      noreply : false,
    };
    this.data = null;
    this.bytesRead = 0;
    this.buffer= null;

    }
  };
  
  /**
   * Handles the data comming from a "data" event on a socket, depending on
   * the current context, it stores data to a Buffer or executes a incoming command.
   *
   * @param {*} chunk The chunk of data.
   * 
   */
  function handleData(chunk){

    if( context.receivingData ){
      
      if( context.bytesRead < context.line.bytes ){
        try { 
         
          readData(chunk, context);
        
        } catch (error) {

          socket.write(`${Globals.RESPONSE.CLIENT_ERROR} ${error.message}\r\n`);
          context.reset();
          return;

        }
      } 
      
      if( context.bytesRead = context.line.bytes ) {

        context.receivingData = false;
        context.bytesRead = 0;
        context.bytes = 0;
        
        executeCommand(context);
      }
  
    } else {
      
      //Finds the position of \r\n
      let i = 0;
      while( !(chunk[i] == 13 && chunk[i+1] == 10) ){
        i++;
      }

      //Since the current "state" is "waiting for a command", we try to parse
      //whatever is in the incomming buffer into a command.
      try {
  
        context.line = commandParser.parseCommand(chunk.slice(0, i+2));
        
      } catch (error) {
        
        socket.write( Globals.RESPONSE.CLIENT_ERROR + " " + error.message + "\r\n" );
        context.reset();
        return;
      }
      
      //If it's a STORE operation, read more data
      if( Globals.OPERATIONS.STORE.includes(context.line.command) ){
        
        if( context.line.bytes > Config.dataMaxSize ){
          socket.write(Globals.RESPONSE.CLIENT_ERROR + " object too large for cache, max size is " + Config.dataMaxSize + "\r\n");
          context.reset();
          return;
        }
        
        context.data = Buffer.allocUnsafe(context.line.bytes);
        context.receivingData = true;
        readData(chunk.slice(i + 2, chunk.length), context, executeCommand);
      }
  
      if( Globals.OPERATIONS.RETRIEVE.includes(context.line.command) ){
  
        executeCommand(context);
      }

      if( Globals.OPERATIONS.QUIT.includes(context.line.command) ){

        executeCommand(context);
      }
    
    }
  
  };

  function readData(chunk, context, callback){
    
    for(let i = 0; i < chunk.length; i++){

      // If the end of data is reached (13 & 10 = \r\n).
      if( chunk[i] == 13 && chunk[i+1] == 10 ){
        
        if( context.bytesRead == context.line.bytes ){
          
          if (callback) 
            callback(context);
          break;
        
        } else {
          
          throw new Error("Bad data chunk");

        }

      } else {

        //If more data than the specified amount is sent
        if( context.bytesRead > context.line.bytes ){

          throw new Error("Bad data chunk");
        
        }

        context.data[context.bytesRead] = chunk[i];
        context.bytesRead++;

      }
    }
  
  };


  /**
   * Executes any of the available cache commands according to the given context data
   * and wirte the result to the socket.
   *
   * @param {Object} context
   */
  function executeCommand(context){
  
    let stored;
    let record;

    switch(context.line.command){

      case "get":
        
        context.line.key.forEach((key) =>{

          record = cache.get(key);
          if ( record )
            socket.write(`VALUE ${key} ${record.flags} ${record.value.length}\r\n${record.value}\r\n`);

        });

        socket.write("END\r\n");

        break;        

      case "gets":
        
        context.line.key.forEach((key) =>{

          record = cache.get(key);
          if ( record )
            socket.write("VALUE " + key + " " + record.flags + " " + record.value.length +  " " + record.casUnique + "\r\n" + record.value + "\r\n");

        });
        
        socket.write("END\r\n");

        break;
      
      case "add":
  
        stored = cache.add(context.line.key, context.line.flags, context.line.expTime, context.data);
        
        if( !context.line.noreply )
          socket.write( stored ? Globals.RESPONSE.STORED : Globals.RESPONSE.NOT_STORED );
        
        break;
  
      case "set":
  
        cache.set(context.line.key, context.line.flags, context.line.expTime, context.data);
  
        if( !context.line.noreply )
          socket.write(Globals.RESPONSE.STORED);
        
        break;

      case "replace":

        stored = cache.replace(context.line.key, context.line.flags, context.line.expTime, context.data);
  
        if(!cache.noreply)
          socket.write( stored ? Globals.RESPONSE.STORED : Globals.RESPONSE.NOT_STORED );
  
        break;
  
      case "append":
  
        stored = cache.append(context.line.key, context.data);
  
        if(!cache.noreply)
          socket.write( stored ? Globals.RESPONSE.STORED : Globals.RESPONSE.NOT_STORED );
  
        break;
  
      case "prepend":
  
        stored  = cache.prepend(context.line.key, context.data);
  
        if(!context.line.noreply)            
          socket.write( stored ? Globals.RESPONSE.STORED : Globals.RESPONSE.NOT_STORED );
  
        break;
  
      case "cas":
  
        stored = cache.cas(context.line.key, context.line.flags, context.line.expTime, context.line.data, context.line.casUnique);
  
        if(!cache.noreply){
          let finalResponse;
  
          switch(true){
          
            case stored.stored:
              finalResponse = Globals.RESPONSE.STORED;
              break;
          
            case stored.notFound:
              finalResponse = Globals.RESPONSE.NOT_FOUND;
              break;
          
            case stored.exists:
              finalResponse = Globals.RESPONSE.EXISTS;
              break;
          }
  
          socket.write(finalResponse);
          
        }

        break;
      
      case "quit":
        socket.destroy();
        break;
  
    }
  
    context.reset();
  
  };

  function handleError(err){
    console.log(`Error: ${err}`);
  };

  function handleEnd(data) {
    console.log(`Socket closed from the client: ${socket.remoteAddress}`);
  };
  
  socket.on('data', handleData);
  socket.on('error', handleError);
  socket.on('end', handleEnd);
  
  console.log(`Client connected from: ${socket.remoteAddress}`);
}
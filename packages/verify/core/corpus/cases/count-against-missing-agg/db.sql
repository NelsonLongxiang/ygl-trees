CREATE TABLE executions (id INTEGER PRIMARY KEY, batch TEXT);
INSERT INTO executions (id,batch) VALUES (1,'b1');
CREATE TABLE policy (id INTEGER PRIMARY KEY, max_executions INTEGER);
INSERT INTO policy (id,max_executions) VALUES (1,1);

CREATE TABLE executions (id INTEGER PRIMARY KEY, status TEXT, batch TEXT);
INSERT INTO executions (id,status,batch) VALUES (1,'ok','b1'),(2,'ok','b1'),(3,'ok','b1');
CREATE TABLE policy (id INTEGER PRIMARY KEY, max_executions INTEGER);
INSERT INTO policy (id,max_executions) VALUES (1,3);

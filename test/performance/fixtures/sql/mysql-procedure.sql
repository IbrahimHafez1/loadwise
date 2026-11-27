-- procedures
DELIMITER //
CREATE PROCEDURE bump(IN id INT)
BEGIN
  UPDATE t SET n = n + 1 WHERE id = id;
  SELECT ';' AS semi;
END//
DELIMITER ;
ALTER TABLE `db`.`orders` ADD INDEX idx_a (a), ALGORITHM=INPLACE, LOCK=NONE;
